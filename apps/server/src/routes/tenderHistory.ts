import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { Router } from 'express';
import { HistoryImportRequest, HistoryQuery, HistoryTaskPatch, HistoryTaskRequest } from '@kontur/contracts';
import { globalCapabilities, formatEtag, historyDigest, prepareLegacyHistory, readLegacyHistory } from '@kontur/core';
import { canReadSharedHistory,canWriteHistory,canManageHistory, getHistoryTask, historySummary, importTenderHistory, insertBlob, listHistoryFiles, listHistoryTasks, listTenderHistory, type Pool } from '@kontur/db';
import type { IAppConfig } from '@kontur/config';
import type { BlobStore } from '@kontur/storage';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadedBlob } from '../http/upload.ts';
import { loadTender, requireTenderCap } from './tenders.ts';
import {historyContentRouter} from './historyContent.ts';

export const tenderHistoryRouter=(pool:Pool,store:BlobStore,config:IAppConfig):Router=>{
  const router=Router();
  router.use(historyContentRouter(pool,store));
  for(const part of ['','/summary','/files','/tasks'] as const){
    router.get('/history'+part,query(pool,'history.read','history',async(ctx,req,res)=>{
      if(!globalCapabilities(ctx.roles).includes('history.read'))throw forbidden('history.read');
      const q=parseBody(HistoryQuery.extend({tenderId:z.union([z.uuid(),z.array(z.uuid()).min(1).max(100).transform(ids=>[...new Set(ids)])]).optional()}),req.query);
      const id=q.tenderId??null;
      if(id&&q.scope==='common')throw new HttpError(400,'VALIDATION_FAILED','Общие материалы не привязаны к тендеру');
      for(const selectedId of id===null?[]:Array.isArray(id)?id:[id])requireTenderCap(ctx,await loadTender(pool,ctx,selectedId),'tender.read');
      try{
        if(part==='/summary')res.json(await historySummary(pool,ctx,id,q.scope));
        else if(part==='/files')res.json(await listHistoryFiles(pool,ctx,id,q));
        else if(part==='/tasks')res.json({items:await listHistoryTasks(pool,ctx,id,q.scope)});
        else res.json(await listTenderHistory(pool,ctx,id,q));
      }catch(err){if(err instanceof Error&&err.message==='history_invalid_cursor')throw new HttpError(400,'VALIDATION_FAILED','Некорректный курсор');throw err;}
    }));
  }
  router.get('/history/members',query(pool,'history.members.read','history',async(ctx,_req,res)=>{
    if(!canReadSharedHistory(ctx))throw forbidden('history.common.read');
    res.json({items:(await pool.query(`SELECT u.id AS "userId",u.display_name AS "displayName" FROM app_user u WHERE u.status='active'
      AND has_role_permission(u.id,'history.write') ORDER BY u.display_name,u.id`)).rows});
  }));
  router.post('/history/tasks',command(pool,{
    action:'history.common.task.create',entityType:'tender_history_task',idempotent:true,
    authorize:async(_db,ctx)=>{if(!canWriteHistory(ctx,null))throw forbidden('history.common.write');},
    run:async(db,ctx,req)=>{
      if(!canWriteHistory(ctx,null))throw forbidden('history.common.write');const body=parseBody(HistoryTaskRequest,req.body);
      if(body.recordId&&!(await db.query(`SELECT r.id FROM tender_history_record r JOIN tender_history_binding b ON b.id=r.binding_id WHERE r.id=$1 AND b.tender_id IS NULL AND NOT r.restricted`,[body.recordId])).rows[0])throw notFound();
      if(body.fileId&&!(await db.query(`SELECT f.id FROM tender_history_file f JOIN tender_history_binding b ON b.id=f.binding_id WHERE f.id=$1 AND b.tender_id IS NULL`,[body.fileId])).rows[0])throw notFound();
      const row=(await db.query(`INSERT INTO tender_history_task(tender_id,record_id,file_id,title,owner_user_id,due_at,created_by,updated_by)
        VALUES(NULL,$1,$2,$3,$4,$5,$6,$6) RETURNING *`,[body.recordId,body.fileId,body.title,body.ownerUserId,body.dueAt,ctx.principal.userId])).rows[0];
      return {status:201,body:row,etag:formatEtag(row.id,row.row_version),audit:[{action:'history.common.task.create',entityType:'tender_history_task',entityId:row.id,details:{}}]};
    },
  }));
  const commonWatch=async(db:Parameters<typeof loadTender>[0],ctx:Parameters<typeof loadTender>[1],req:Parameters<typeof uuidParam>[0])=>{
    const id=uuidParam(req,'id','tender_history_binding');
    if(!canReadSharedHistory(ctx))throw notFound();
    const row=(await db.query(`SELECT w.row_version FROM tender_history_watch w JOIN tender_history_binding b ON b.id=w.binding_id WHERE w.binding_id=$1 AND b.tender_id IS NULL FOR UPDATE OF w`,[id])).rows[0];
    if(!row)throw notFound();if(!canManageHistory(ctx,null))throw forbidden('history.common.manage');return {id,row};
  };
  router.put('/history-watches/:id',command(pool,{
    action:'history.common.watch.configure',entityType:'tender_history_binding',authorize:async(db,ctx,req)=>{await commonWatch(db,ctx,req);},
    run:async(db,ctx,req)=>{
      const {id,row}=await commonWatch(db,ctx,req),body=parseBody(z.object({enabled:z.boolean()}).strict(),req.body);
      if(requireIfMatch(req,id)!==row.row_version)throw versionConflict(row);
      const next=(await db.query(`UPDATE tender_history_watch SET enabled=$2,configured_by=$3,row_version=row_version+1,last_scheduled_at=NULL,last_verify_scheduled_at=NULL WHERE binding_id=$1 RETURNING row_version AS "rowVersion"`,[id,body.enabled,ctx.principal.userId])).rows[0];
      return {status:200,body:next,etag:formatEtag(id,next.rowVersion),audit:[{action:'history.common.watch.configure',entityType:'tender_history_binding',entityId:id,details:{enabled:body.enabled}}]};
    },
  }));
  for(const part of ['history-summary','history','history-files','history-tasks'] as const) {
    router.get('/tenders/:id/'+part,query(pool,'tender.'+part+'.read','tender',async(ctx,req,res)=>{
      const id=uuidParam(req,'id','tender'),t=await loadTender(pool,ctx,id);
      requireTenderCap(ctx,t,'tender.read');
      const q=parseBody(HistoryQuery,req.query);
      try {
        if(part==='history-summary')res.json(await historySummary(pool,ctx,id));
        else if(part==='history')res.json(await listTenderHistory(pool,ctx,id,q));
        else if(part==='history-files')res.json(await listHistoryFiles(pool,ctx,id,q));
        else res.json({items:await listHistoryTasks(pool,ctx,id)});
      }catch(err){if(err instanceof Error&&err.message==='history_invalid_cursor')throw new HttpError(400,'VALIDATION_FAILED','Некорректный курсор');throw err;}
    }));
  }
  const authorizeImport=async(db:Parameters<typeof loadTender>[0],ctx:Parameters<typeof loadTender>[1],req:Parameters<typeof uuidParam>[0])=>{
    const id=uuidParam(req,'id','tender'),t=await loadTender(db,ctx,id);
    requireTenderCap(ctx,t,'source.write');
    if(!canManageHistory(ctx,id))throw forbidden('hold.resolve',{tenderId:id});
  };
  router.get('/tenders/:id/history-report-sources',query(pool,'tender.history.sources.read','tender',async(ctx,req,res)=>{
    await authorizeImport(pool,ctx,req);
    res.json({items:(config.historyReportPaths??[]).map(p=>({key:historyDigest(p),label:basename(p)}))});
  }));
  router.put('/tenders/:id/history-sync',command(pool,{
    action:'tender.history.sync.configure',entityType:'tender',authorize:authorizeImport,
    run:async(db,ctx,req)=>{
      await authorizeImport(db,ctx,req);
      const tenderId=uuidParam(req,'id','tender');
      const body=parseBody(z.object({bindingId:z.uuid(),sourceKey:z.string().regex(/^[a-f0-9]{64}$/),enabled:z.boolean()}).strict(),req.body);
      const binding=(await db.query('SELECT id FROM tender_history_binding WHERE id=$1 AND tender_id=$2',[body.bindingId,tenderId])).rows[0];
      if(!binding)throw notFound();
      const reportPath=(config.historyReportPaths??[]).find(p=>historyDigest(p)===body.sourceKey);
      if(!reportPath)throw new HttpError(400,'VALIDATION_FAILED','Источник отчёта не разрешён в настройках сервера');
      await db.query("SELECT pg_advisory_xact_lock(hashtext('history_sync'),hashtext($1))",[body.bindingId]);
      const old=(await db.query('SELECT row_version FROM tender_history_sync WHERE binding_id=$1',[body.bindingId])).rows[0];
      if(requireIfMatch(req,body.bindingId)!==(old?.row_version??0))throw versionConflict({rowVersion:old?.row_version??0});
      const next=(await db.query(`INSERT INTO tender_history_sync(binding_id,report_path,enabled,configured_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(binding_id) DO UPDATE SET report_path=$2,enabled=$3,configured_by=$4,row_version=tender_history_sync.row_version+1,last_scheduled_at=NULL
        RETURNING binding_id AS "bindingId",enabled,row_version AS "rowVersion"`,[body.bindingId,reportPath,body.enabled,ctx.principal.userId])).rows[0]!;
      return {status:200,body:next,etag:formatEtag(body.bindingId,next.rowVersion),
        audit:[{action:'tender.history.sync.configure',entityType:'tender_history_binding',entityId:body.bindingId,tenderId,details:{enabled:body.enabled,sourceKey:body.sourceKey}}]};
    },
  }));
  router.put('/tenders/:id/history-watch',command(pool,{
    action:'tender.history.watch.configure',entityType:'tender',authorize:authorizeImport,
    run:async(db,ctx,req)=>{
      await authorizeImport(db,ctx,req);const tenderId=uuidParam(req,'id','tender');
      const body=parseBody(z.object({bindingId:z.uuid(),enabled:z.boolean()}).strict(),req.body);
      const old=(await db.query(`SELECT w.row_version FROM tender_history_watch w JOIN tender_history_binding b ON b.id=w.binding_id WHERE w.binding_id=$1 AND b.tender_id=$2 FOR UPDATE OF w`,[body.bindingId,tenderId])).rows[0];
      if(!old)throw notFound();if(requireIfMatch(req,body.bindingId)!==old.row_version)throw versionConflict(old);
      const next=(await db.query(`UPDATE tender_history_watch SET enabled=$2,configured_by=$3,row_version=row_version+1,last_scheduled_at=NULL,last_verify_scheduled_at=NULL WHERE binding_id=$1 RETURNING row_version AS "rowVersion"`,[body.bindingId,body.enabled,ctx.principal.userId])).rows[0];
      return {status:200,body:next,etag:formatEtag(body.bindingId,next.rowVersion),audit:[{action:'history.watch.configure',entityType:'tender_history_binding',entityId:body.bindingId,tenderId,details:{enabled:body.enabled}}]};
    },
  }));
  router.post('/tenders/:id/history-import',
    receiveUpload({pool,store,config:{...config,limits:{...config.limits,maxUploadBytes:40*1024*1024}},
      action:'tender.history.import',entityType:'tender',
      authorize:async(req)=>authorizeImport(pool,requireCtx(req),req)}),
    command(pool,{
      action:'tender.history.import',entityType:'tender',idempotent:true,authorize:authorizeImport,
      requestKey:(req)=>req.originalUrl+'\n'+uploadedBlob(req)?.sha256,
      run:async(db,ctx,req)=>{
        await authorizeImport(db,ctx,req);
        const id=uuidParam(req,'id','tender'),blob=uploadedBlob(req);
        if(!blob)throw new HttpError(400,'VALIDATION_FAILED','Нет загруженного отчёта');
        let body:ReturnType<typeof HistoryImportRequest.parse>;
        try {
          const text=await readFile(store.pathOf(blob.sha256),'utf8');
          const source=readLegacyHistory(text);
          const manifest=prepareLegacyHistory(source,String(req.query.folderId??''));
          body=parseBody(HistoryImportRequest,{confirmBinding:req.query.confirmBinding==='true',manifest});
        }catch(err){
          if(err instanceof HttpError)throw err;
          throw new HttpError(400,'VALIDATION_FAILED','Отчёт не принят: '+(err instanceof Error?err.message:'некорректный формат'));
        }
        await insertBlob(db,{sha256:blob.sha256,sizeBytes:blob.sizeBytes,mediaType:'application/octet-stream',storageKey:blob.storageKey});
        try {
          const result=await importTenderHistory(db,ctx,id,body.manifest);
          return {status:200,body:result,audit:[{action:'tender.history.import',entityType:'tender',entityId:id,tenderId:id,
            details:{importId:result.importId,artifactSha256:blob.sha256,recordsAdded:result.recordsAdded,filesAdded:result.filesAdded,repeated:result.repeated}}]};
        }catch(err){if(err instanceof Error&&err.message==='history_binding_conflict')throw new HttpError(409,'STATE_CONFLICT','Эта папка уже привязана к другой карточке');throw err;}
      },
    }));
  router.post('/tenders/:id/history-tasks',command(pool,{
    action:'tender.history.task.create',entityType:'tender',idempotent:true,
    authorize:async(db,ctx,req)=>requireTenderCap(ctx,await loadTender(db,ctx,uuidParam(req,'id','tender')),'source.write'),
    run:async(db,ctx,req)=>{
      const tenderId=uuidParam(req,'id','tender'),t=await loadTender(db,ctx,tenderId);
      requireTenderCap(ctx,t,'source.write');
      const body=parseBody(HistoryTaskRequest,req.body);
      if(body.recordId&&!((await db.query(`SELECT r.id FROM tender_history_record r JOIN tender_history_binding b ON b.id=r.binding_id
        WHERE r.id=$1 AND b.tender_id=$2 AND NOT r.restricted`,[body.recordId,tenderId])).rows[0]))throw notFound();
      if(body.fileId&&!((await db.query(`SELECT f.id FROM tender_history_file f JOIN tender_history_binding b ON b.id=f.binding_id
        WHERE f.id=$1 AND b.tender_id=$2`,[body.fileId,tenderId])).rows[0]))throw notFound();
      const row=(await db.query(`INSERT INTO tender_history_task(tender_id,record_id,file_id,title,owner_user_id,due_at,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,[tenderId,body.recordId,body.fileId,body.title,body.ownerUserId,body.dueAt,ctx.principal.userId])).rows[0]!;
      return {status:201,body:row,etag:formatEtag(row.id,row.row_version),audit:[{action:'tender.history.task.create',entityType:'tender_history_task',entityId:row.id,tenderId,details:{}}]};
    },
  }));
  router.patch('/history-tasks/:id',command(pool,{
    action:'tender.history.task.update',entityType:'tender_history_task',
    authorize:async(db,ctx,req)=>{
      const row=await getHistoryTask(db,ctx,uuidParam(req,'id','tender_history_task'));if(!row)throw notFound();
      if(row.tender_id!==null)requireTenderCap(ctx,await loadTender(db,ctx,row.tender_id),'source.write');
      else if(!canWriteHistory(ctx,null))throw forbidden('history.common.write');
    },
    run:async(db,ctx,req)=>{
      const id=uuidParam(req,'id','tender_history_task'),row=await getHistoryTask(db,ctx,id);
      if(!row)throw notFound();
      if(row.tender_id!==null)requireTenderCap(ctx,await loadTender(db,ctx,row.tender_id),'source.write');
      else if(!canWriteHistory(ctx,null))throw forbidden('history.common.write');
      const expected=requireIfMatch(req,id); if(expected!==row.row_version)throw versionConflict(row);
      const body=parseBody(HistoryTaskPatch,req.body);
      const after=(await db.query(`UPDATE tender_history_task SET status=$3,owner_user_id=$4,due_at=$5,resolution=$6,
        updated_by=$7,updated_at=now(),row_version=row_version+1 WHERE id=$1 AND row_version=$2 RETURNING *`,
        [id,expected,body.status,body.ownerUserId,body.dueAt,body.resolution,ctx.principal.userId])).rows[0];
      if(!after)throw versionConflict(row);
      return {status:200,body:after,etag:formatEtag(id,after.row_version),audit:[{action:'tender.history.task.update',entityType:'tender_history_task',entityId:id,tenderId:row.tender_id,details:{status:after.status}}]};
    },
  }));
  return router;
};
