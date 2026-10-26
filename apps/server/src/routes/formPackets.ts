import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { canonicalJson, formatEtag, sha256Hex } from '@kontur/core';
import { getTemplateRevision, insertBlob, type Pool, type Queryable, type IAccessContext } from '@kontur/db';
import { renderDocx, renderXlsx, MEDIA_TYPES, scanDocxTags, scanXlsxTags } from '@kontur/adapters';
import type { BlobStore } from '@kontur/storage';
import type { IAppConfig } from '@kontur/config';
import { blankGroupUnitPrices } from '../../../../packages/adapters/src/office/groupPrices.ts';
import { createOfficeConverter } from '../../../worker/src/office/libreoffice.ts';
import { PacketInput, compilePacket, packetChanges, type IPacketInput } from '../formPackets.ts';
import { checkCalculationTotals } from '../formPacketMoney.ts';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadedBlob, uploadName } from '../http/upload.ts';
import { readStoredBlob } from '../releaseMarkup.ts';
import { loadStage } from './stages.ts';
import { hasTenderCap } from './scope.ts';

interface PacketRow { id: string; stage_id: string; title: string; based_on_id: string | null; current_version_id: string | null; row_version: number; input: IPacketInput | null; seq: number | null; sha256: string | null }
const SELECT = `SELECT p.*,v.input,v.seq,v.sha256 FROM form_packet p LEFT JOIN form_packet_version v ON v.id=p.current_version_id`;
const invalid = (detail: string) => new HttpError(400, 'VALIDATION_FAILED', detail);
const safeName = (name: string): string => {
  if (!name || /[\\/\x00-\x1f]/u.test(name) || name === '.' || name === '..') throw invalid('Имя файла должно быть без каталога');
  return name;
};
export const formPacketsRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();
  const access = async (db: Queryable, ctx: IAccessContext, stageId: string, write = false) => {
    const stage = await loadStage(db, ctx, stageId);
    if (write && !hasTenderCap(ctx, stage.tender_id, 'application.fill')) throw forbidden('application.fill', { entityType: 'tender_stage', entityId: stage.id, tenderId: stage.tender_id });
    return stage;
  };
  const load = async (db: Queryable, ctx: IAccessContext, req: Request, write = false, lock = false): Promise<PacketRow> => {
    const id = uuidParam(req, 'id', 'form_packet');
    const p = (await db.query<PacketRow>(`${SELECT} WHERE p.id=$1${lock ? ' FOR UPDATE OF p' : ''}`, [id])).rows[0];
    if (!p) throw notFound({ entityType: 'form_packet', entityId: id });
    await access(db, ctx, p.stage_id, write);
    return p;
  };
  const calculationCheck=async(db:Queryable,input:IPacketInput|null)=>{
    if(!input?.calculationRevisionId)return null;
    const row=(await db.query<{header:string;positions:string}>(`SELECT c.kp_total::text AS header,COALESCE((SELECT sum(p.commercial_total) FROM calculation_position p WHERE p.content_id=c.id),0)::text AS positions FROM calculation_revision r JOIN calculation_content c ON c.id=r.content_id WHERE r.id=$1`,[input.calculationRevisionId])).rows[0];
    const insurance=input.calculationInsurance?.calculationRevisionId===input.calculationRevisionId?input.calculationInsurance:undefined;
    return row?{...checkCalculationTotals(row.header,row.positions,insurance?.amount),insuranceBasis:insurance?.basis??null}:null;
  };
  const view = async (db: Queryable, p: PacketRow) => ({
    ...p, etag: formatEtag(p.id, p.row_version),
    summary:p.input?Object.fromEntries(Object.entries(compilePacket(p.input).data).filter(([k])=>['th_total','nomination_total','kp_total_before_bond','performance_bond_amount','performance_bond_bank_fee','performance_bond_price_addition','kp_total','vat_amount'].includes(k))):null,
    calculationCheck:await calculationCheck(db,p.input),
    sources: (await db.query(`SELECT s.id,s.name,s.blob_sha256,s.role,s.origin FROM form_packet_source s JOIN form_packet p ON p.id=s.packet_id WHERE p.stage_id=$1 ORDER BY s.created_at`, [p.stage_id])).rows,
    history: (await db.query('SELECT id,seq,sha256,changes,created_at FROM form_packet_version WHERE packet_id=$1 ORDER BY seq DESC', [p.id])).rows,
    builds: (await db.query(`SELECT b.id,b.version_id,b.issues,b.created_at,COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'sha256',f.blob_sha256) ORDER BY f.name) FILTER(WHERE f.id IS NOT NULL),'[]') AS files FROM form_packet_build b JOIN form_packet_version v ON v.id=b.version_id LEFT JOIN form_packet_file f ON f.build_id=b.id WHERE v.packet_id=$1 GROUP BY b.id ORDER BY b.created_at DESC`, [p.id])).rows,
  });
  const saveVersion = async (db: Queryable, p: PacketRow, input: IPacketInput, userId: string) => {
    if(input.calculationRevisionId){
      const calc=(await db.query<{kp_total:string|null}>(`SELECT c.kp_total::text FROM calculation_revision r JOIN calculation_content c ON c.id=r.content_id WHERE r.id=$1 AND r.stage_id=$2`,[input.calculationRevisionId,p.stage_id])).rows[0];
      if(!calc?.kp_total)throw invalid('Ревизия расчёта отсутствует, относится к другому этапу или не имеет итога');
      input.values.th_total=calc.kp_total;
    }else if(input.values.th_total)throw invalid('Сумма TenderHub должна быть связана с ревизией расчёта');
    const compiled = compilePacket(input);
    const stage = (await db.query<{tender_id:string}>('SELECT tender_id FROM tender_stage WHERE id=$1',[p.stage_id])).rows[0]!;
    for (const out of input.definition.outputs) {
      safeName(out.name);
      const r = await getTemplateRevision(db, out.revisionId);
      if (!r || r.is_demo || (r.tender_id !== null && r.tender_id !== stage.tender_id) || !r.marked_sample_blob_sha256 || !['docx','xlsx'].includes(r.output_format ?? '')) throw invalid('Нужна реальная размеченная ревизия шаблона этого тендера');
      if (r.owner_kind === 'company' && r.status !== 'approved') throw invalid('Неутверждённый шаблон компании не используется в тендерном черновике');
    }
    const sourceIds = [...new Set([...input.attachments.map(a=>a.sourceId), ...input.positions.flatMap(x=>x.sourceId ? [x.sourceId] : [])])];
    if (sourceIds.length) {
      const allowed = await db.query<{id:string}>(`SELECT s.id FROM form_packet_source s JOIN form_packet p ON p.id=s.packet_id WHERE p.stage_id=$1 AND s.id=ANY($2::uuid[])`, [p.stage_id, sourceIds]);
      if (allowed.rows.length !== sourceIds.length) throw invalid('Источник отсутствует или относится к другому этапу');
      if(input.attachments.length){const attachable=await db.query('SELECT id FROM form_packet_source WHERE id=ANY($1::uuid[]) AND role=$2',[input.attachments.map(a=>a.sourceId),'attachment']);if(attachable.rows.length!==input.attachments.length)throw invalid('Внешний комплект не включает внутренние файлы и источники для сверки');}
    }
    const id = randomUUID();
    await db.query('INSERT INTO form_packet_version(id,packet_id,seq,input,sha256,changes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,p.id,(p.seq??0)+1,input,sha256Hex(canonicalJson(input)),JSON.stringify(packetChanges(p.input,input)),userId]);
    await db.query('UPDATE form_packet SET current_version_id=$2,row_version=row_version+1 WHERE id=$1',[p.id,id]);
    return compiled;
  };
  router.get('/stages/:id/form-packets', query(pool,'forms.packet.list','form_packet',async(ctx,req,res)=>{
    const stage = await access(pool,ctx,uuidParam(req,'id','tender_stage'));
    const rows = (await pool.query<PacketRow>(`${SELECT} WHERE p.stage_id=$1 ORDER BY p.created_at DESC`,[stage.id])).rows;
    res.json({items:await Promise.all(rows.map(p=>view(pool,p))),canFill:hasTenderCap(ctx,stage.tender_id,'application.fill')});
  }));
  router.post('/stages/:id/form-packets', command(pool,{
    action:'forms.packet.create',entityType:'form_packet',idempotent:true,
    authorize:async(db,ctx,req)=>{await access(db,ctx,uuidParam(req,'id','tender_stage'),true);},
    run:async(db,ctx,req)=>{
      const stage=await access(db,ctx,uuidParam(req,'id','tender_stage'),true);
      const body=parseBody(z.object({title:z.string().trim().min(1).max(300),basedOnId:z.uuid().optional()}).strict(),req.body);
      let base: PacketRow|undefined;
      if(body.basedOnId) {
        base=(await db.query<PacketRow>(`${SELECT} WHERE p.id=$1 AND p.stage_id=$2`,[body.basedOnId,stage.id])).rows[0];
        if(!base) throw notFound({entityType:'form_packet',entityId:body.basedOnId});
      }
      const id=randomUUID();
      await db.query('INSERT INTO form_packet(id,stage_id,title,based_on_id,created_by) VALUES($1,$2,$3,$4,$5)',[id,stage.id,body.title,base?.id??null,ctx.principal.userId]);
      if(base?.input) await saveVersion(db,{...base,id,current_version_id:null,input:null,seq:null},base.input,ctx.principal.userId);
      const p=(await db.query<PacketRow>(`${SELECT} WHERE p.id=$1`,[id])).rows[0]!;
      return {status:201,body:await view(db,p),etag:formatEtag(p.id,p.row_version),audit:[{action:'forms.packet.create',entityType:'form_packet',entityId:id,tenderId:stage.tender_id,details:{basedOnId:base?.id??null,mode:'owner_review_draft'}}]};
    },
  }));
  router.put('/form-packets/:id',command(pool,{
    action:'forms.packet.edit',entityType:'form_packet',
    authorize:async(db,ctx,req)=>{await load(db,ctx,req,true);},
    run:async(db,ctx,req)=>{
      const p=await load(db,ctx,req,true,true);
      if(requireIfMatch(req,p.id)!==p.row_version) throw versionConflict({etag:formatEtag(p.id,p.row_version)});
      const input=parseBody(PacketInput,req.body);
      try { await saveVersion(db,p,input,ctx.principal.userId); } catch(e) { if(e instanceof HttpError)throw e; if(e instanceof Error && !('code' in e))throw invalid(e.message); throw e; }
      const updated=(await db.query<PacketRow>(`${SELECT} WHERE p.id=$1`,[p.id])).rows[0]!;
      const stage=await access(db,ctx,p.stage_id);
      return {status:200,body:await view(db,updated),etag:formatEtag(updated.id,updated.row_version),audit:[{action:'forms.packet.edit',entityType:'form_packet',entityId:p.id,tenderId:stage.tender_id,details:{version:updated.seq}}]};
    },
  }));
  router.post('/form-packets/:id/sources',receiveUpload({pool,store,config,action:'forms.packet.source',entityType:'form_packet',authorize:async(req)=>{await load(pool,requireCtx(req),req,true);}}),command(pool,{
    action:'forms.packet.source',entityType:'form_packet',idempotent:true,
    requestKey:req=>`${req.originalUrl}:${uploadedBlob(req)?.sha256??''}`,
    authorize:async(db,ctx,req)=>{await load(db,ctx,req,true);},
    run:async(db,ctx,req)=>{
      const p=await load(db,ctx,req,true); const stored=uploadedBlob(req)!;
      await insertBlob(db,{sha256:stored.sha256,sizeBytes:stored.sizeBytes,storageKey:stored.storageKey,mediaType:'application/octet-stream'});
      const role=parseBody(z.enum(['reference','attachment','internal']),req.query.role??'reference');
      const origin=parseBody(z.string().max(2000),req.query.origin??'');
      const source=(await db.query('INSERT INTO form_packet_source(packet_id,name,blob_sha256,created_by,role,origin) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,blob_sha256,role,origin',[p.id,uploadName(req),stored.sha256,ctx.principal.userId,role,origin])).rows[0];
      const stage=await access(db,ctx,p.stage_id);
      return {status:201,body:source,audit:[{action:'forms.packet.source',entityType:'form_packet',entityId:p.id,tenderId:stage.tender_id,details:{sourceId:source.id,sha256:stored.sha256}}]};
    },
  }));
  router.post('/form-packets/:id/build',command(pool,{
    action:'forms.packet.build',entityType:'form_packet',idempotent:true,
    authorize:async(db,ctx,req)=>{await load(db,ctx,req,true);},
    run:async(db,ctx,req)=>{
      const p=await load(db,ctx,req,true,true);
      if(requireIfMatch(req,p.id)!==p.row_version)throw versionConflict({etag:formatEtag(p.id,p.row_version)});
      if(!p.input)throw invalid('Сначала заполните параметры комплекта');
      const opts=parseBody(z.object({previewPdf:z.boolean().default(true)}).strict(),req.body);
      const compiled=compilePacket(p.input), buildId=randomUUID();
      const issues=[...compiled.issues,'Проверочный черновик: шаблоны и коммерческие условия ожидают проверки владельца; это не выпуск КП'];
      const check=await calculationCheck(db,p.input);
      if(check&&!check.reconciled)issues.push(`Не сверена шапка TenderHub с суммой позиций: нерасшифрованный остаток ${check.unexplainedDifferenceDisplay} руб. Цена требует проверки источника`);
      const converter=opts.previewPdf?createOfficeConverter(config.office):null;
      if(opts.previewPdf&&!converter)throw invalid('Конвертер PDF недоступен');
      await db.query('INSERT INTO form_packet_build(id,version_id,issues,created_by) VALUES($1,$2,$3,$4)',[buildId,p.current_version_id,JSON.stringify(issues),ctx.principal.userId]);
      const files: {id:string;name:string;sha256:string}[]=[];
      const put=async(name:string,bytes:Buffer,media:string,sourceId:string|null=null,revisionId:string|null=null)=>{
        const b=await store.putStream(Readable.from([bytes]),config.limits.maxUploadBytes);
        await insertBlob(db,{sha256:b.sha256,sizeBytes:b.sizeBytes,storageKey:b.storageKey,mediaType:media});
        const id=randomUUID();
        await db.query('INSERT INTO form_packet_file(id,build_id,name,blob_sha256,media_type,source_id,template_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,buildId,safeName(name),b.sha256,media,sourceId,revisionId]);
        files.push({id,name,sha256:b.sha256});
      };
      for(const output of p.input.definition.outputs) {
        if(output.mechanism&&output.mechanism!==p.input.values.c08_mechanism)continue;
        const rev=(await getTemplateRevision(db,output.revisionId))!;
        const stage=await access(db,ctx,p.stage_id);
        if(!rev||rev.is_demo||(rev.tender_id!==null&&rev.tender_id!==stage.tender_id))throw invalid('Шаблон недоступен');
        const sample=await readStoredBlob(store,rev.marked_sample_blob_sha256!);
        const format=rev.output_format as 'docx'|'xlsx';
        const tags=format==='docx'?scanDocxTags(sample):scanXlsxTags(sample);
        for(const tag of tags) if(tag.key && !(tag.key in compiled.data)) throw invalid(`В общих данных нет поля шаблона: ${tag.key}`);
        const bytes=format==='docx'?renderDocx(sample,compiled.data,['ЧЕРНОВИК']):renderXlsx(sample,compiled.data,compiled.numbers,['ЧЕРНОВИК']);
        await put(output.name,bytes,MEDIA_TYPES[format],null,rev.id);
        if(converter) await put(output.name.replace(/\.[^.]+$/u,'.pdf'),await converter.toPdf(bytes,format),MEDIA_TYPES.pdf,null,rev.id);
      }
      for(const a of p.input.attachments) {
        const source=(await db.query<{name:string;blob_sha256:string}>(`SELECT s.name,s.blob_sha256 FROM form_packet_source s JOIN form_packet p ON p.id=s.packet_id WHERE s.id=$1 AND p.stage_id=$2`,[a.sourceId,p.stage_id])).rows[0];
        if(!source)throw invalid('Вложение недоступно');
        const raw=await readStoredBlob(store,source.blob_sha256);
        const bytes=a.blankUnitPriceRows?.length?blankGroupUnitPrices(raw,a.blankUnitPriceRows):raw;
        await put(source.name,bytes,'application/octet-stream',a.sourceId);
      }
      await put('manifest.json',Buffer.from(canonicalJson({mode:'owner_review_draft',packetId:p.id,versionId:p.current_version_id,inputSha256:p.sha256,calculationCheck:check,issues,files:[...files]}),'utf8'),'application/json');
      const stage=await access(db,ctx,p.stage_id);
      return {status:201,body:{id:buildId,versionId:p.current_version_id,issues,files},audit:[{action:'forms.packet.build',entityType:'form_packet',entityId:p.id,tenderId:stage.tender_id,details:{buildId,versionId:p.current_version_id,mode:'owner_review_draft'}}]};
    },
  }));
  router.get('/form-packet-files/:id',query(pool,'forms.packet.file.read','form_packet',async(ctx,req,res)=>{
    const file=(await pool.query<{name:string;blob_sha256:string;media_type:string;stage_id:string}>(`SELECT f.*,p.stage_id FROM form_packet_file f JOIN form_packet_build b ON b.id=f.build_id JOIN form_packet_version v ON v.id=b.version_id JOIN form_packet p ON p.id=v.packet_id WHERE f.id=$1`,[uuidParam(req,'id','form_packet_file')])).rows[0];
    if(!file)throw notFound({entityType:'form_packet_file'});
    await access(pool,ctx,file.stage_id);
    res.type(file.media_type).setHeader('Content-Disposition',`${file.media_type==='application/pdf'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.end(await readStoredBlob(store,file.blob_sha256));
  }));
  router.get('/form-packet-sources/:id',query(pool,'forms.packet.source.read','form_packet_source',async(ctx,req,res)=>{
    const source=(await pool.query<{name:string;blob_sha256:string;stage_id:string}>(`SELECT s.name,s.blob_sha256,p.stage_id FROM form_packet_source s JOIN form_packet p ON p.id=s.packet_id WHERE s.id=$1`,[uuidParam(req,'id','form_packet_source')])).rows[0];
    if(!source)throw notFound({entityType:'form_packet_source'});
    await access(pool,ctx,source.stage_id);
    res.type('application/octet-stream').setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`);
    res.end(await readStoredBlob(store,source.blob_sha256));
  }));
  return router;
};
