import { tenderCapabilities, globalCapabilities, rolePermission, type IHistoryImport, historyPath } from '@kontur/core';
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export const canReadSharedHistory=(ctx:IAccessContext):boolean=>rolePermission(ctx.roles,'history.read',ctx.roles.has('manager')||ctx.roles.has('engineer'));
export const canWriteHistory=(ctx:IAccessContext,tenderId:string|null):boolean=>tenderId===null?canReadSharedHistory(ctx)&&rolePermission(ctx.roles,'history.write',true):
 tenderCapabilities(ctx.roles,ctx.memberships.get(tenderId)??null).includes('source.write');
export const canManageHistory = (ctx: IAccessContext, tenderId: string|null): boolean => tenderId===null?
 canReadSharedHistory(ctx)&&rolePermission(ctx.roles,'history.manage',ctx.roles.has('admin')):
 contentTenderIds(ctx).includes(tenderId) && (globalCapabilities(ctx.roles).includes('admin.tender') || tenderCapabilities(ctx.roles, ctx.memberships.get(tenderId) ?? null).includes('hold.resolve'));
export type HistoryTenderFilter=string|string[]|null;
const historyScope=async(db:Queryable,ctx:IAccessContext,tenderId:HistoryTenderFilter):Promise<string[]>=>{
 const readable=(await db.query<{id:string}>("SELECT id FROM tender WHERE status='active' AND id=ANY($1::uuid[])",[contentTenderIds(ctx)])).rows.map(t=>t.id);
 if(tenderId===null)return readable;
 const selected=[...new Set((Array.isArray(tenderId)?tenderId:[tenderId]).filter(id=>readable.includes(id)))];
 if(!selected.length)return [];
 const related=(await db.query(`SELECT b.tender_id FROM tender_history_related r JOIN tender_history_binding b ON b.id=r.binding_id
   WHERE r.tender_id=ANY($1::uuid[]) AND b.tender_id=ANY($2::uuid[])`,[selected,readable])).rows;
 return [...new Set([...selected,...related.map(r=>r.tender_id as string)])];
};

export const importTenderHistory = async (db: Queryable, ctx: IAccessContext, tenderId: string|null, m: IHistoryImport,origin:'legacy'|'filesystem'='legacy') => {
  if (!canManageHistory(ctx, tenderId)) throw new Error('history_access_denied');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('tender_history'),hashtext($1))", [m.externalFolderId]);
  const existing = await db.query<{ id: string; tender_id: string|null }>('SELECT id,tender_id FROM tender_history_binding WHERE external_folder_id=$1', [m.externalFolderId]);
  if (existing.rows[0] && existing.rows[0].tender_id !== tenderId) throw new Error('history_binding_conflict');
  const bindingId = existing.rows[0]?.id ?? (await db.query<{ id: string }>(
    'INSERT INTO tender_history_binding(tender_id,external_folder_id,folder_name,created_by) VALUES($1,$2,$3,$4) RETURNING id',
    [tenderId,m.externalFolderId,m.folderName,ctx.principal.userId])).rows[0]!.id;
  const old = await db.query<{id:string}>('SELECT id FROM tender_history_import WHERE binding_id=$1 AND source_sha256=$2',[bindingId,m.sourceSha256]);
  if (old.rows[0]) return { bindingId, importId: old.rows[0].id, repeated: true, recordsAdded: 0, filesAdded: 0 };
  const keySet = new Set<string>(), pathSet = new Set<string>();
  for (const r of m.records) { if (keySet.has(r.key)) throw new Error('history_duplicate_record'); keySet.add(r.key); if (r.sourcePath) historyPath(r.sourcePath); }
  for (const f of m.files) { const k=historyPath(f.path).normalize('NFC').toLowerCase(); if(pathSet.has(k)) throw new Error('history_duplicate_path'); pathSet.add(k); }
  const importId=(await db.query<{id:string}>(`INSERT INTO tender_history_import(binding_id,source_sha256,observed_at,observation_started_at,complete,imported_by,folder_name,origin)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[bindingId,m.sourceSha256,m.observedAt,m.observationStartedAt,m.complete,ctx.principal.userId,m.folderName,origin])).rows[0]!.id;
  const previous=(await db.query<{id:string;external_key:string;revision:number;payload_sha256:string}>(`SELECT DISTINCT ON(external_key) id,external_key,revision,payload_sha256
    FROM tender_history_record WHERE binding_id=$1 ORDER BY external_key,revision DESC`,[bindingId])).rows;
  const byKey=new Map(previous.map(r=>[r.external_key,r]));
  let recordsAdded=0;
  for(const r of m.records) {
    const p=byKey.get(r.key); if(p?.payload_sha256===r.payloadSha256) continue;
    await db.query(`INSERT INTO tender_history_record(binding_id,import_id,external_key,revision,previous_id,payload_sha256,kind,title,detail,occurred_at,source_path,source_label,restricted,technical)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [bindingId,importId,r.key,(p?.revision??0)+1,p?.id??null,r.payloadSha256,r.kind,r.title,r.detail,r.occurredAt,r.sourcePath,r.sourceLabel,r.restricted||r.kind==='mail',r.technical]);
    recordsAdded++;
  }
  for(let start=0;start<m.files.length;start+=1000) {
    await db.query(`INSERT INTO tender_history_file(binding_id,import_id,relative_path,path_key,size_bytes,sha256,modified_at,verified_at,status,technical)
      SELECT $1,$2,x.path,lower(normalize(x.path,NFC)),x.size,x.sha256,x."modifiedAt"::timestamptz,x."verifiedAt"::timestamptz,x.status,x.technical
      FROM jsonb_to_recordset($3::jsonb) AS x(path text,size bigint,sha256 text,"modifiedAt" text,"verifiedAt" text,status text,technical boolean)`,
      [bindingId,importId,JSON.stringify(m.files.slice(start,start+1000))]);
  }
  return { bindingId,importId,repeated:false,recordsAdded,filesAdded:m.files.length };
};

export type HistoryScope='all'|'common'|'tenders';
const scopeFor=async(db:Queryable,ctx:IAccessContext,tenderId:HistoryTenderFilter,scope:HistoryScope='all')=>({
 ids:scope==='common'?[]:await historyScope(db,ctx,tenderId),shared:tenderId===null&&scope!=='tenders'&&canReadSharedHistory(ctx),
});
const historyEntriesSql=(sharedParameter:number)=>`
    SELECT r.id::text AS id,r.kind,r.title,r.detail,coalesce(r.occurred_at,r.created_at) AS sort_at,
      r.occurred_at AS "occurredAt",r.created_at AS "importedAt",r.revision,i.id AS "importId",r.source_path AS "sourcePath",r.source_label AS "sourceLabel",
      CASE WHEN i.origin='filesystem' THEN 'observation' ELSE 'historical' END AS origin,(r.technical OR lower(coalesce(r.source_path,'')) LIKE '%.slog') AS technical,b.folder_name AS "folderName",r.id AS "recordId",NULL::uuid AS "stageId",b.tender_id AS "tenderId",coalesce(t.code,'Общие материалы') AS "tenderCode",NULL::text AS "actorName",NULL::text AS "actorKind",NULL::uuid AS "batchId"
    FROM tender_history_record r JOIN tender_history_import i ON i.id=r.import_id JOIN tender_history_binding b ON b.id=r.binding_id LEFT JOIN tender t ON t.id=b.tender_id
    WHERE (b.tender_id=ANY($1::uuid[]) OR($${sharedParameter} AND b.tender_id IS NULL)) AND NOT r.restricted AND NOT EXISTS(SELECT 1 FROM tender_history_record n WHERE n.binding_id=r.binding_id AND n.external_key=r.external_key AND n.revision>r.revision)
    UNION ALL SELECT 'portal:'||e.id,e.event_type,
      CASE e.event_type
        WHEN 'import_accepted' THEN 'Поступил комплект документов'
        WHEN 'document_revision_registered' THEN 'Зарегистрирована редакция документа'
        WHEN 'source_set_changed' THEN 'Изменён состав документов этапа'
        WHEN 'recognition_run_completed' THEN 'Завершено распознавание документа'
        WHEN 'calculation_revision_added' THEN 'Добавлена ревизия расчёта'
        WHEN 'communication_linked' THEN 'Связана переписка с этапом'
        WHEN 'transcript_revision_added' THEN 'Обновлена расшифровка'
        WHEN 'qa_form_added' THEN 'Добавлены вопросы и ответы'
        WHEN 'decision_recorded' THEN 'Записано решение'
        WHEN 'draft_field_changed' THEN 'Изменено поле приложения'
        ELSE 'Событие этапа' END,
      '',e.created_at,e.created_at,e.created_at,1,NULL::uuid,NULL,'Портал','portal',
      e.event_type IN('document_revision_registered','recognition_run_completed'),s.title,NULL,e.stage_id,s.tender_id,t.code,u.display_name,e.actor_kind,CASE WHEN e.event_type='import_accepted' AND e.ref_type='import_batch' THEN e.ref_id ELSE NULL END
      FROM stage_input_event e JOIN tender_stage s ON s.id=e.stage_id JOIN tender t ON t.id=s.tender_id LEFT JOIN app_user u ON u.id=e.actor_user_id WHERE s.tender_id=ANY($1::uuid[])
`;
export const historySummary = async (db: Queryable, ctx: IAccessContext, tenderId: HistoryTenderFilter,scope:HistoryScope='all') => {
  const {ids,shared}=await scopeFor(db,ctx,tenderId,scope);
  if(tenderId!==null&&!ids.length) return null;
  const bindings=(await db.query(`SELECT b.id,b.tender_id AS "tenderId",coalesce(t.code,'Общие материалы') AS "tenderCode",b.external_folder_id AS "externalFolderId",coalesce(i.folder_name,b.folder_name) AS "folderName",
    i.observed_at AS "observedAt",i.observation_started_at AS "observationStartedAt",i.complete,
    i.created_at AS "importedAt",i.id AS "importId",
    CASE WHEN EXISTS(SELECT 1 FROM tender_history_observation o WHERE o.binding_id=b.id) THEN
      (SELECT count(*)::int FROM tender_history_observation o WHERE o.binding_id=b.id AND o.present) ELSE
      (SELECT count(*)::int FROM tender_history_file f WHERE f.import_id=i.id) END AS files
    FROM tender_history_binding b LEFT JOIN tender t ON t.id=b.tender_id LEFT JOIN LATERAL(SELECT * FROM tender_history_import WHERE binding_id=b.id AND origin='legacy' ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1)i ON true
    WHERE b.tender_id=ANY($1::uuid[]) OR($2 AND b.tender_id IS NULL) ORDER BY b.created_at`,[ids,shared])).rows;
  const taskCounts=(await db.query(`SELECT count(*) FILTER(WHERE status<>'resolved')::int AS open,
    count(*) FILTER(WHERE status<>'resolved' AND due_at<now())::int AS overdue FROM tender_history_task WHERE tender_id=ANY($1::uuid[]) OR($2 AND tender_id IS NULL)`,[ids,shared])).rows[0];
  const sync=(await db.query(`SELECT s.binding_id AS "bindingId",s.enabled,s.row_version AS "rowVersion",s.last_checked_at AS "lastCheckedAt",
    s.last_success_at AS "lastSuccessAt",s.last_error_code AS "lastErrorCode" FROM tender_history_sync s
    JOIN tender_history_binding b ON b.id=s.binding_id WHERE b.tender_id=ANY($1::uuid[]) OR($2 AND b.tender_id IS NULL)`,[ids,shared])).rows;
  const watch=(await db.query(`SELECT w.binding_id AS "bindingId",w.enabled,w.row_version AS "rowVersion",w.last_checked_at AS "lastCheckedAt",w.last_success_at AS "lastSuccessAt",w.last_error_code AS "lastErrorCode",w.last_full_hash_at AS "lastFullHashAt",w.scan_interval_seconds AS "intervalSeconds",jsonb_array_length(w.directory_paths) AS directories,
    (SELECT count(*)::int FROM tender_history_observation o WHERE o.binding_id=w.binding_id AND o.present AND o.sha256 IS NULL) AS unverified
    FROM tender_history_watch w JOIN tender_history_binding b ON b.id=w.binding_id WHERE b.tender_id=ANY($1::uuid[]) OR($2 AND b.tender_id IS NULL)`,[ids,shared])).rows;
  const related=tenderId?(await db.query(`SELECT b.tender_id AS "tenderId",t.code AS "tenderCode",string_agg(DISTINCT r.reason,' ' ORDER BY r.reason) AS reason FROM tender_history_related r JOIN tender_history_binding b ON b.id=r.binding_id JOIN tender t ON t.id=b.tender_id
    WHERE r.tender_id=ANY($1::uuid[]) AND r.tender_id=ANY($2::uuid[]) AND b.tender_id=ANY($2::uuid[]) GROUP BY b.tender_id,t.code`,[Array.isArray(tenderId)?tenderId:[tenderId],ids])).rows:[];
  const changedProjects=(await db.query(`WITH entries AS (${historyEntriesSql(2)}), project_scopes AS (
    SELECT id AS project_id,id AS source_id FROM tender WHERE id=ANY($1::uuid[])
    UNION SELECT r.tender_id,b.tender_id FROM tender_history_related r JOIN tender_history_binding b ON b.id=r.binding_id
      WHERE r.tender_id=ANY($1::uuid[]) AND b.tender_id=ANY($1::uuid[])
    ), projected AS (
    SELECT e.id,e.sort_at,e.technical,e.kind,s.project_id FROM entries e JOIN project_scopes s ON s.source_id=e."tenderId"
    UNION ALL SELECT e.id,e.sort_at,e.technical,e.kind,NULL::uuid FROM entries e WHERE e."tenderId" IS NULL
    ) SELECT e.project_id AS "tenderId",coalesce(t.code,'Общие материалы') AS "tenderCode",coalesce(t.title,'Общие условия и шаблоны') AS title,
      count(*)::int AS changes,max(e.sort_at) AS "lastChangedAt"
    FROM projected e LEFT JOIN tender t ON t.id=e.project_id
    WHERE NOT e.technical AND e.kind NOT IN('baseline','directory_baseline')
    GROUP BY e.project_id,t.code,t.title ORDER BY max(e.sort_at) DESC,t.code`,[ids,shared])).rows;
  return {bindings:bindings.map(row=>({...row,canManage:canManageHistory(ctx,row.tenderId)})),tasks:taskCounts,sync,watch,related,changedProjects,canWriteCommon:canWriteHistory(ctx,null),canManage:typeof tenderId==='string'&&canManageHistory(ctx,tenderId)};
};

export interface IHistoryPageQuery { cursor?:string; limit:number; q:string; kind:string; technical:string;scope?:HistoryScope;fileFacts?:string }
export const historyCursor = (raw?:string): [string,string]|null => {
  if(!raw) return null;
  try { const p=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); if(Array.isArray(p)&&p.length===2&&typeof p[0]==='string'&&Number.isFinite(Date.parse(p[0]))&&typeof p[1]==='string'&&/^[a-z0-9:-]{1,100}$/i.test(p[1])) return p as [string,string]; } catch { /* invalid cursor */ }
  throw new Error('history_invalid_cursor');
};
export const listTenderHistory = async(db:Queryable,ctx:IAccessContext,tenderId:HistoryTenderFilter,q:IHistoryPageQuery) => {
  const {ids,shared}=await scopeFor(db,ctx,tenderId,q.scope);
  if(!ids.length&&!shared) return {items:[],nextCursor:null};
  const cursor=historyCursor(q.cursor);
  const rows=(await db.query(`WITH entries AS (${historyEntriesSql(8)}) SELECT *,sort_at::text AS cursor_at FROM entries WHERE ($2='' OR position(lower($2) in lower(title||' '||detail))>0
      OR EXISTS(SELECT 1 FROM import_batch b WHERE b.id=entries."batchId" AND b.tender_id=entries."tenderId"
        AND (position(lower($2) in lower(coalesce(b.upload_name,'')))>0 OR EXISTS(
          SELECT 1 FROM import_item i WHERE i.batch_id=b.id AND i.tender_id=b.tender_id
            AND position(lower($2) in lower(i.member_path||' '||i.observed_name))>0))))
      AND ($3='' OR kind=$3) AND ($4 OR (NOT technical AND kind NOT IN('baseline','directory_baseline')))
      AND ($5::timestamptz IS NULL OR (sort_at,id)<($5::timestamptz,$6::text))
      ORDER BY sort_at DESC,id DESC LIMIT $7`,
    [ids,q.q,q.kind,q.technical==='true',cursor?.[0]??null,cursor?.[1]??null,q.limit+1,shared])).rows;
  const more=rows.length>q.limit,items=rows.slice(0,q.limit),last=items.at(-1);
  const evidence=q.fileFacts==='false'?[]:items.filter(row=>row.origin==='observation'&&row.sourcePath).map(row=>({id:row.id,importId:row.importId,path:row.sourcePath}));
  const facts=evidence.length?(await db.query(`SELECT e.id,
    jsonb_build_object('before',CASE WHEN v.record_id IS NOT NULL THEN
      CASE WHEN exact_before.id IS NULL THEN NULL ELSE jsonb_build_object('size',exact_before.size_bytes,'modifiedAt',exact_before.modified_at,'sha256',exact_before.sha256) END
      WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('size',p.size_bytes,'modifiedAt',p.modified_at,'sha256',p.sha256) END,
    'after',jsonb_build_object('size',f.size_bytes,'modifiedAt',f.modified_at,'sha256',f.sha256)) AS value
    FROM jsonb_to_recordset($1::jsonb) AS e(id text,"importId" uuid,path text)
    JOIN LATERAL (
      SELECT * FROM tender_history_file WHERE import_id=e."importId" AND path_key=lower(normalize(e.path,NFC)) LIMIT 1
    )f ON true LEFT JOIN LATERAL (
      SELECT record_id,before_file_id FROM tender_history_record_versions WHERE record_id=e.id::uuid LIMIT 1
    )v ON true LEFT JOIN LATERAL (
      SELECT id,size_bytes,modified_at,sha256 FROM tender_history_file WHERE id=v.before_file_id LIMIT 1
    )exact_before ON true JOIN LATERAL (
      SELECT created_at FROM tender_history_import WHERE id=f.import_id LIMIT 1
    )i ON true LEFT JOIN LATERAL(
      SELECT pf.* FROM tender_history_file pf JOIN tender_history_import pi ON pi.id=pf.import_id
      WHERE v.record_id IS NULL AND pf.binding_id=f.binding_id AND pf.path_key=f.path_key AND pi.created_at<i.created_at
      ORDER BY pi.created_at DESC,pf.id DESC LIMIT 1
    )p ON true`,[JSON.stringify(evidence)])).rows:[];
  const receiptKeys=[...new Map(items.filter(row=>row.batchId).map(row=>[row.batchId+':'+row.tenderId,{id:row.batchId,tenderId:row.tenderId}])).values()];
  const receipts=receiptKeys.length?(await db.query(
    `SELECT b.id,b.tender_id AS "tenderId",b.upload_name AS "uploadName",b.source_kind AS "sourceKind",b.status,b.expanded_at IS NOT NULL AS expanded,
      counts.*,coalesce(preview.paths,'[]'::jsonb) AS preview
    FROM jsonb_to_recordset($1::jsonb) AS selected(id uuid,"tenderId" uuid)
    JOIN import_batch b ON b.id=selected.id AND b.tender_id=selected."tenderId"
    CROSS JOIN LATERAL(SELECT count(*)::int AS total,
      count(*) FILTER(WHERE i.status='registered')::int AS registered,count(*) FILTER(WHERE i.status='duplicate')::int AS duplicate,
      count(*) FILTER(WHERE i.status='pending')::int AS pending,count(*) FILTER(WHERE i.status='rejected')::int AS rejected,
      count(*) FILTER(WHERE i.status='skipped_partial')::int AS skipped
      FROM import_item i WHERE i.batch_id=b.id AND i.tender_id=b.tender_id)counts
    CROSS JOIN LATERAL(SELECT jsonb_agg(p.member_path ORDER BY p.member_path) AS paths FROM(
      SELECT i.member_path FROM import_item i WHERE i.batch_id=b.id AND i.tender_id=b.tender_id ORDER BY i.member_path LIMIT 3)p)preview`,
    [JSON.stringify(receiptKeys)])).rows:[];
  const receiptById=new Map(receipts.map(({tenderId,...row})=>[row.id+':'+tenderId,row]));
  const byId=new Map(facts.map(f=>[f.id,f.value]));
  return {items:items.map(({sort_at,cursor_at,importId,batchId,...row})=>{
    const receipt=receiptById.get(batchId+':'+row.tenderId);
    const count=receipt?.total??0,word=count%100>=11&&count%100<=14?'файлов':count%10===1?'файл':count%10>=2&&count%10<=4?'файла':'файлов';
    const title=receipt?(count?(word==='файл'?'Поступил ':'Поступило ')+count+' '+word:receipt.uploadName?'Поступила загрузка: '+receipt.uploadName:'Поступление документов — состав уточняется'):row.title;
    return {...row,title,importBatch:receipt??null,fileChange:byId.get(row.id)??null};
  }),nextCursor:more&&last?Buffer.from(JSON.stringify([last.cursor_at,last.id])).toString('base64url'):null};
};
export const listHistoryFiles=async(db:Queryable,ctx:IAccessContext,tenderId:HistoryTenderFilter,q:IHistoryPageQuery)=>{
  const {ids,shared}=await scopeFor(db,ctx,tenderId,q.scope);
  if(!ids.length&&!shared)return {items:[],nextCursor:null};
  const cursor=q.cursor; if(cursor&&!/^[0-9a-f-]{36}$/i.test(cursor))throw new Error('history_invalid_cursor');
  // Page each source through its existing (binding,path) index before merging. A UUID
  // cursor resolves to its immutable path, so new snapshots keep the page boundary.
  const rows=(await db.query(`WITH bindings AS MATERIALIZED (
      SELECT b.id,b.tender_id,b.folder_name,coalesce(t.code,'Общие материалы') AS code,
        w.binding_id AS watch_id,w.last_success_at,w.last_error_code
      FROM tender_history_binding b LEFT JOIN tender t ON t.id=b.tender_id LEFT JOIN tender_history_watch w ON w.binding_id=b.id
      WHERE b.tender_id=ANY($1::uuid[]) OR($6 AND b.tender_id IS NULL)
    ), boundary AS MATERIALIZED (
      SELECT f.binding_id,f.path_key FROM tender_history_file f JOIN bindings b ON b.id=f.binding_id WHERE f.id=$4::uuid
    ), legacy_bindings AS MATERIALIZED (
      SELECT b.* FROM bindings b WHERE NOT EXISTS(SELECT 1 FROM tender_history_observation o WHERE o.binding_id=b.id)
    ), files AS (
      SELECT f.id,f.relative_path AS path,f.size_bytes AS size,f.sha256,f.modified_at AS "modifiedAt",f.verified_at AS "verifiedAt",f.status,f.technical,
        i.folder_name AS "folderName",i.observed_at AS "observedAt",i.complete,b.tender_id AS "tenderId",b.code AS "tenderCode",b.id AS "bindingId",f.path_key AS "pathKey"
      FROM legacy_bindings b CROSS JOIN LATERAL (
        SELECT id,folder_name,observed_at,complete FROM tender_history_import WHERE binding_id=b.id AND origin='legacy'
        ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1
      )i CROSS JOIN LATERAL (
        SELECT f.* FROM tender_history_file f WHERE f.import_id=i.id
          AND ($4::uuid IS NULL OR (b.id,f.path_key)>(SELECT binding_id,path_key FROM boundary))
          AND ($2='' OR position(lower($2) in lower(f.relative_path||' '||coalesce(f.sha256,'')))>0)
          AND ($3 OR (NOT f.technical AND lower(f.relative_path) NOT LIKE '%.slog'))
        ORDER BY f.path_key LIMIT $5
      )f
      UNION ALL
      SELECT o.id,o.relative_path,o.size_bytes,o.sha256,to_timestamp(o.mtime_ms/1000.0),o.verified_at,o.status,o.technical,
        b.folder_name,b.last_success_at,b.last_error_code IS NULL,b.tender_id,b.code,b.id,o.path_key
      FROM bindings b CROSS JOIN LATERAL (
        SELECT o.relative_path,o.size_bytes,o.sha256,o.mtime_ms,o.verified_at,o.status,o.path_key,f.id,f.technical
        FROM tender_history_observation o CROSS JOIN LATERAL (
          SELECT id,technical FROM tender_history_file WHERE id=o.file_id LIMIT 1
        )f WHERE o.binding_id=b.id AND b.watch_id IS NOT NULL
          AND ($4::uuid IS NULL OR (o.binding_id,o.path_key)>(SELECT binding_id,path_key FROM boundary))
          AND ($2='' OR position(lower($2) in lower(o.relative_path||' '||coalesce(o.sha256,'')))>0)
          AND ($3 OR (NOT f.technical AND lower(o.relative_path) NOT LIKE '%.slog'))
        ORDER BY o.path_key LIMIT $5
      )o
    ) SELECT * FROM files ORDER BY "bindingId","pathKey" LIMIT $5`,
    [ids,q.q,q.technical==='true',cursor??null,q.limit+1,shared])).rows;
  return {items:rows.slice(0,q.limit).map(({bindingId,pathKey,...row})=>row),nextCursor:rows.length>q.limit?rows[q.limit-1]!.id:null};
};
export const listHistoryTasks=async(db:Queryable,ctx:IAccessContext,tenderId:HistoryTenderFilter,scope:HistoryScope='all')=>{
  const {ids,shared}=await scopeFor(db,ctx,tenderId,scope);
  if(!ids.length&&!shared)return [];
  return (await db.query(`SELECT t.*,u.display_name AS owner_name,coalesce(td.code,'Общие материалы') AS tender_code FROM tender_history_task t LEFT JOIN app_user u ON u.id=t.owner_user_id
    LEFT JOIN tender td ON td.id=t.tender_id WHERE t.tender_id=ANY($1::uuid[]) OR($2 AND t.tender_id IS NULL) ORDER BY (t.status='resolved'),t.due_at NULLS LAST,t.created_at DESC LIMIT 200`,[ids,shared])).rows;
};
export const getHistoryTask=async(db:Queryable,ctx:IAccessContext,id:string)=>
  (await db.query('SELECT * FROM tender_history_task WHERE id=$1 AND(tender_id=ANY($2::uuid[]) OR($3 AND tender_id IS NULL))',[id,contentTenderIds(ctx),canReadSharedHistory(ctx)])).rows[0]??null;
