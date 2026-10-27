import {createHash} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {HISTORY_CONTENT_MAX_BYTES,historyCanArchive,historyContentMediaType,historyDigest,historyTechnical,type IHistoryImport,type IHistoryFileInput,type IHistoryRecordInput} from '@kontur/core';
import {canManageHistory,enqueueJob,historyContentPendingPredicate,insertBlob,importTenderHistory,loadAccessContext,withTransaction,writeAudit,type Pool,type Queryable} from '@kontur/db';
import {isStorageFull,type IStoredBlob} from '@kontur/storage';
import {PermanentJobError,type IJobContext,type IJobHandlerSpec} from '../jobTypes.ts';
import {assertUnchanged,openVerifiedFile} from './safeRead.ts';
import {pathWithin,walkHistoryRoot} from './historyWalk.ts';

interface IWatch {binding_id:string;tender_id:string|null;external_folder_id:string;folder_name:string;root_path:string;configured_by:string;enabled:boolean;row_version:number;stability_seconds:number}
interface IObservation {path_key:string;relative_path:string;file_id:string;size_bytes:number;mtime_ms:number;sha256:string|null;verified_at:Date|null;stable_since:Date;present:boolean;missing_count:number;status:string;last_seen_at:Date}
interface IVersionRecord extends IHistoryRecordInput {beforeFileId?:string;beforeAbsent?:boolean;afterAbsent?:boolean}
const keyOf=(path:string)=>path.normalize('NFC').toLowerCase();
export const nightlyHistoryCutoff=(now=new Date()):Date=>{
 const local=new Date(now.getTime()+3*3600_000);local.setUTCHours(2,0,0,0);
 let time=local.getTime()-3*3600_000;if(time>now.getTime())time-=86400_000;return new Date(time);
};
export const seedHistoryObservations=async(db:Queryable,bindingId:string)=>{
 await db.query(`INSERT INTO tender_history_observation(binding_id,path_key,relative_path,file_id,size_bytes,mtime_ms,sha256,verified_at,stable_since,last_seen_at,status)
 SELECT f.binding_id,f.path_key,f.relative_path,f.id,f.size_bytes,coalesce(floor(extract(epoch FROM f.modified_at)*1000),0)::bigint,f.sha256,f.verified_at,
 i.observed_at,i.observed_at,f.status FROM tender_history_file f JOIN tender_history_import i ON i.id=f.import_id
 WHERE f.import_id=(SELECT id FROM tender_history_import WHERE binding_id=$1 AND origin='legacy' ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1)
 ON CONFLICT(binding_id,path_key) DO NOTHING`,[bindingId]);
};
export const scheduleHistoryWatch=async(pool:Pool):Promise<number>=>{
 const rows=(await pool.query(`SELECT w.binding_id,b.tender_id,
  w.last_scheduled_at IS NULL OR w.last_scheduled_at<now()-make_interval(secs=>w.scan_interval_seconds) AS scan,
  w.last_verify_scheduled_at IS NULL OR w.last_verify_scheduled_at<now()-interval '5 minutes' AS verify
  FROM tender_history_watch w JOIN tender_history_binding b ON b.id=w.binding_id WHERE w.enabled`)).rows;
 let count=0;
 for(const r of rows)await withTransaction(pool,async db=>{
  for(const mode of ['scan','verify'] as const)if(r[mode]){
   await enqueueJob(db,{kind:'history.'+mode,dedupeKey:'history-'+mode+':'+r.binding_id,payload:{bindingId:r.binding_id},tenderId:r.tender_id,resourceClass:'network',priority:mode==='scan'?20:5});
   await db.query(`UPDATE tender_history_watch SET ${mode==='scan'?'last_scheduled_at':'last_verify_scheduled_at'}=now() WHERE binding_id=$1`,[r.binding_id]);count++;
  }
 });return count;
};
const accessFor=async(db:Queryable,row:IWatch,ctx:IJobContext)=>{
 const access=await loadAccessContext(db,row.configured_by,'history-watch:'+ctx.job.id);
 if(!access||!canManageHistory(access,row.tender_id))throw new PermanentJobError('history_access_revoked','Отозваны права на наблюдение папки');return access;
};
const loadWatch=async(ctx:IJobContext)=>{
 const row=(await ctx.pool.query<IWatch>(`SELECT w.*,b.tender_id,b.external_folder_id,b.folder_name FROM tender_history_watch w JOIN tender_history_binding b ON b.id=w.binding_id
 WHERE w.binding_id=$1 AND w.enabled`,[String(ctx.job.payload.bindingId)])).rows[0];
 if(!row)return null;
 if(!(ctx.config.historyWatchRoots??[]).some(root=>pathWithin(row.root_path,root)))throw new PermanentJobError('history_root_not_allowed','Папка вне разрешённых корней');
 await accessFor(ctx.pool,row,ctx);return row;
};
const validatePhysicalRoot=async(ctx:IJobContext,row:IWatch)=>{
 const canonical=await realpath(row.root_path);
 for(const root of ctx.config.historyWatchRoots??[]){if(!pathWithin(row.root_path,root))continue;const st=await lstat(root);if(st.isDirectory()&&!st.isSymbolicLink()&&pathWithin(canonical,await realpath(root)))return;}
 throw new Error('history_physical_root_unsafe');
};
const stillCurrent=async(db:Queryable,row:IWatch,ctx:IJobContext)=>{
 const current=(await db.query('SELECT enabled,row_version FROM tender_history_watch WHERE binding_id=$1 FOR UPDATE',[row.binding_id])).rows[0];
 if(!current?.enabled||current.row_version!==row.row_version)return false;await accessFor(db,row,ctx);return true;
};
const scanLog=async(db:Queryable,ctx:IJobContext,row:IWatch,mode:string,start:Date,complete:boolean,seen:number,changed:number,hashed:number,errors:string[])=>{
 await db.query(`INSERT INTO tender_history_scan(binding_id,job_id,mode,started_at,finished_at,complete,files_seen,changed,hashed,errors) VALUES($1,$2,$3,$4,greatest(clock_timestamp(),$4::timestamptz),$5,$6,$7,$8,$9)`,
 [row.binding_id,ctx.job.id,mode,start,complete,seen,changed,hashed,JSON.stringify(errors.slice(0,100))]);
};
const observations=async(db:Queryable,id:string)=>(await db.query<IObservation>('SELECT * FROM tender_history_observation WHERE binding_id=$1',[id])).rows;
const fileInput=(o:IObservation):IHistoryFileInput=>({path:o.relative_path,size:o.size_bytes,sha256:o.sha256,modifiedAt:new Date(o.mtime_ms).toISOString(),verifiedAt:o.verified_at?.toISOString()??null,status:o.status,technical:historyTechnical(o.relative_path)});
const event=(kind:string,path:string,jobId:string,detail:string,now:Date,version:Pick<IVersionRecord,'beforeFileId'|'beforeAbsent'|'afterAbsent'>={}):IVersionRecord=>({key:'fs:'+jobId+':'+keyOf(path),kind,title:({file_added:'Добавлен файл: ',file_modified:'Изменены свойства файла: ',file_missing:'Файл пропал из папки: ',file_restored:'Файл снова доступен: ',file_content_changed:'Изменилось содержимое файла: '} as Record<string,string>)[kind]+path,detail,occurredAt:now.toISOString(),sourcePath:path,sourceLabel:'Файлы Tender',payloadSha256:historyDigest({kind,path,detail,jobId}),restricted:false,technical:historyTechnical(path),...version});
const fileDate=(value:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'medium'}).format(new Date(value));
const metadataDetail=(old:IObservation|undefined,file:{size:number;mtimeMs:number})=>[
 old&&old.size_bytes!==file.size?'Размер: '+old.size_bytes+' → '+file.size+' байт.':'Размер: '+file.size+' байт.',
 old&&Math.abs(old.mtime_ms-file.mtimeMs)>1?'Время изменения файла: '+fileDate(old.mtime_ms)+' → '+fileDate(file.mtimeMs)+'.':'Время изменения файла: '+fileDate(file.mtimeMs)+'.',
 'Содержимое будет проверено после стабилизации файла.',
].join('\n');
const publish=async(db:Queryable,ctx:IJobContext,row:IWatch,start:Date,now:Date,files:IHistoryFileInput[],records:IVersionRecord[])=>{
 if(!files.length&&!records.length)return new Map<string,string>();
 const manifest:IHistoryImport={schema:'tender-history/1',externalFolderId:row.external_folder_id,folderName:row.folder_name,observationStartedAt:start.toISOString(),observedAt:now.toISOString(),complete:true,
 sourceSha256:historyDigest({job:ctx.job.id,files,records}),files,records};
 const result=await importTenderHistory(db,await accessFor(db,row,ctx),row.tender_id,manifest,'filesystem');
 const ids=(await db.query<{id:string;path_key:string}>('SELECT id,path_key FROM tender_history_file WHERE import_id=$1',[result.importId])).rows;
 const fileIds=new Map(ids.map(f=>[f.path_key,f.id]));
 const recordIds=new Map((await db.query<{id:string;external_key:string}>('SELECT id,external_key FROM tender_history_record WHERE import_id=$1',[result.importId])).rows.map(r=>[r.external_key,r.id]));
 for(const r of records)if(r.sourcePath&&r.kind.startsWith('file_'))await db.query(`INSERT INTO tender_history_record_versions(record_id,before_file_id,after_file_id,before_absent,after_absent)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(record_id) DO NOTHING`,[recordIds.get(r.key),r.beforeFileId??null,r.afterAbsent?null:fileIds.get(keyOf(r.sourcePath))??null,r.beforeAbsent??false,r.afterAbsent??false]);
 const attention=records.filter(r=>!r.technical&&r.kind!=='directory_baseline');
 if(attention.length)await db.query(`INSERT INTO tender_history_task(tender_id,record_id,title,owner_user_id,created_by,updated_by)
   SELECT $1,r.id,$3,$4,$4,$4 FROM tender_history_record r WHERE r.import_id=$2 AND NOT r.technical AND r.kind<>'directory_baseline' ORDER BY r.id LIMIT 1
   ON CONFLICT(record_id) WHERE record_id IS NOT NULL DO NOTHING`,[row.tender_id,result.importId,'Проверить изменения: '+attention.length+' · '+row.folder_name,row.configured_by]);
 await writeAudit(db,{actorUserId:null,principalKind:'system',action:'history.files.observed',entityType:'tender_history_binding',entityId:row.binding_id,tenderId:row.tender_id,requestId:'history-watch:'+ctx.job.id,outcome:'allowed',details:{importId:result.importId,files:files.length,events:records.length}});
 return fileIds;
};
const saveObservations=async(db:Queryable,bindingId:string,rows:IObservation[])=>{
 for(let i=0;i<rows.length;i+=1000)await db.query(`INSERT INTO tender_history_observation(binding_id,path_key,relative_path,file_id,size_bytes,mtime_ms,sha256,verified_at,stable_since,present,missing_count,status,last_seen_at)
 SELECT $1,x.path_key,x.relative_path,x.file_id,x.size_bytes,x.mtime_ms,x.sha256,x.verified_at,x.stable_since,x.present,x.missing_count,x.status,x.last_seen_at
 FROM jsonb_to_recordset($2::jsonb) AS x(path_key text,relative_path text,file_id uuid,size_bytes bigint,mtime_ms bigint,sha256 text,verified_at timestamptz,stable_since timestamptz,present boolean,missing_count int,status text,last_seen_at timestamptz)
 ON CONFLICT(binding_id,path_key) DO UPDATE SET relative_path=excluded.relative_path,file_id=excluded.file_id,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,
 sha256=excluded.sha256,verified_at=excluded.verified_at,stable_since=excluded.stable_since,present=excluded.present,missing_count=excluded.missing_count,status=excluded.status,last_seen_at=excluded.last_seen_at`,[bindingId,JSON.stringify(rows.slice(i,i+1000))]);
};
const terminal:IJobHandlerSpec['onTerminalFailure']=async(db,ctx,failure)=>{await db.query('UPDATE tender_history_watch SET last_checked_at=now(),last_error_code=$2 WHERE binding_id=$1',[String(ctx.job.payload.bindingId),failure.code]);};
export const historyScanHandler:IJobHandlerSpec={onTerminalFailure:terminal,run:async ctx=>{
 const row=await loadWatch(ctx);if(!row)return;const start=new Date();
 let walked:Awaited<ReturnType<typeof walkHistoryRoot>>;
 try{await validatePhysicalRoot(ctx,row);walked=await walkHistoryRoot(row.root_path,()=>ctx.throwIfStopped());}
 catch{ctx.throwIfStopped();await ctx.complete(async db=>{if(!await stillCurrent(db,row,ctx))return;await scanLog(db,ctx,row,'scan',start,false,0,0,0,['root_unavailable']);await db.query("UPDATE tender_history_watch SET last_checked_at=now(),last_error_code='history_root_unavailable' WHERE binding_id=$1",[row.binding_id]);});return;}
 ctx.throwIfStopped();
 await ctx.complete(async db=>{
  if(!await stillCurrent(db,row,ctx))return;
  if(!walked.complete){await scanLog(db,ctx,row,'scan',start,false,walked.files.length,0,0,walked.errors);await db.query("UPDATE tender_history_watch SET last_checked_at=now(),last_error_code='history_scan_incomplete' WHERE binding_id=$1",[row.binding_id]);return;}
  await seedHistoryObservations(db,row.binding_id);
  const previous=new Map((await observations(db,row.binding_id)).map(o=>[o.path_key,o])),now=new Date(),next:IObservation[]=[],changed:IHistoryFileInput[]=[],records:IVersionRecord[]=[];
  const directoryState=(await db.query<{directory_paths:string[];directory_initialized:boolean}>('SELECT directory_paths,directory_initialized FROM tender_history_watch WHERE binding_id=$1',[row.binding_id])).rows[0]!,oldDirectories=directoryState.directory_paths;
  if((directoryState.directory_initialized||row.tender_id===null)&&historyDigest(oldDirectories)!==historyDigest(walked.directories)){
   const before=new Set(oldDirectories),after=new Set(walked.directories),kind=directoryState.directory_initialized?'directory_structure_changed':'directory_baseline';
   const added=walked.directories.filter(d=>!before.has(d)),missing=oldDirectories.filter(d=>!after.has(d));
   const detail=(added.length?'Добавлены каталоги ('+added.length+'):\n'+added.slice(0,100).join('\n'):'')+(missing.length?'\nОтсутствуют каталоги ('+missing.length+'):\n'+missing.slice(0,100).join('\n'):'')+(added.length>100||missing.length>100?'\nПоказаны первые 100 путей каждого вида.':'');
   records.push({key:'fs:'+ctx.job.id+':directories',kind,title:(kind==='directory_baseline'?'Первое наблюдение структуры папок: ':'Изменилась структура папок: ')+row.folder_name,detail,occurredAt:now.toISOString(),sourcePath:null,sourceLabel:'Наблюдение структуры каталогов',payloadSha256:historyDigest({kind,detail}),restricted:false,technical:false});
  }
  for(const f of walked.files){
   const key=keyOf(f.path),old=previous.get(key);previous.delete(key);
   const metadataChanged=!old||!old.present||old.size_bytes!==f.size||Math.abs(old.mtime_ms-f.mtimeMs)>1;
   const o:IObservation={path_key:key,relative_path:f.path,file_id:old?.file_id??'',size_bytes:f.size,mtime_ms:f.mtimeMs,sha256:metadataChanged?null:old.sha256,verified_at:metadataChanged?null:old.verified_at,
    stable_since:metadataChanged?now:old.stable_since,present:true,missing_count:0,status:metadataChanged?'observed':old.status==='missing_pending'?'ok':old.status,last_seen_at:now};
   if(metadataChanged){changed.push(fileInput(o));records.push(event(!old?'file_added':!old.present?'file_restored':'file_modified',f.path,ctx.job.id,metadataDetail(old,f),now,{beforeFileId:old?.present?old.file_id:undefined,beforeAbsent:!old||!old.present}));}next.push(o);
  }
  for(const old of previous.values()){
   if(!old.present)continue;
   const missing=old.missing_count+1,o={...old,missing_count:missing,present:missing<2,status:missing<2?'missing_pending':'missing'};
   if(missing===2){changed.push(fileInput(o));records.push(event('file_missing',o.relative_path,ctx.job.id,'Путь отсутствует в двух последовательных полных обходах; это не подтверждает удаление пользователем.',now,{beforeFileId:old.file_id,afterAbsent:true}));}next.push(o);
  }
  const ids=await publish(db,ctx,row,start,now,changed,records);for(const o of next)o.file_id=ids.get(o.path_key)??o.file_id;
  await saveObservations(db,row.binding_id,next);await scanLog(db,ctx,row,'scan',start,true,walked.files.length,records.length,0,[]);
  await db.query('UPDATE tender_history_watch SET last_checked_at=now(),last_success_at=now(),last_error_code=NULL,directory_paths=$2,directory_initialized=true WHERE binding_id=$1',[row.binding_id,JSON.stringify(walked.directories)]);
 });
}};
export const historyVerifyHandler:IJobHandlerSpec={onTerminalFailure:terminal,run:async ctx=>{
 const row=await loadWatch(ctx);if(!row)return;const start=new Date(),cutoff=nightlyHistoryCutoff(start);
 const candidates=(await ctx.pool.query<IObservation>(`SELECT o.* FROM tender_history_observation o WHERE binding_id=$1 AND present AND missing_count=0 AND stable_since<=now()-make_interval(secs=>$2)
  AND(sha256 IS NULL OR verified_at IS NULL OR verified_at<$3 OR(${historyContentPendingPredicate})) ORDER BY verified_at NULLS FIRST,path_key LIMIT 16`,[row.binding_id,row.stability_seconds,cutoff])).rows;
 if(!candidates.length){await ctx.complete(async db=>{if(await stillCurrent(db,row,ctx))await db.query('UPDATE tender_history_watch SET last_full_hash_at=(SELECT min(verified_at) FROM tender_history_observation WHERE binding_id=$1 AND present) WHERE binding_id=$1 AND NOT EXISTS(SELECT 1 FROM tender_history_observation WHERE binding_id=$1 AND present AND(sha256 IS NULL OR verified_at IS NULL OR verified_at<$2))',[row.binding_id,cutoff]);});return;}
 const results:{old:IObservation;sha256:string;at:Date;blob:IStoredBlob|null}[]=[],errors:string[]=[];let bytes=0;
 let processed=0;
 await ctx.reportProgress?.({phase:'processing',completed:0,total:candidates.length,unit:'files'});
 try{
  await validatePhysicalRoot(ctx,row);
  const st=await lstat(row.root_path);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('unsafe');const canonical=await realpath(row.root_path);
  for(const old of candidates){
   ctx.throwIfStopped();if(bytes>=512*1024*1024)break;
   try{const opened=await openVerifiedFile(join(row.root_path,old.relative_path),canonical,{size:old.size_bytes,mtimeMs:old.mtime_ms});
    try{let sha256:string,read=0,blob:IStoredBlob|null=null;
     if(historyCanArchive(old.relative_path,old.size_bytes)&&!historyTechnical(old.relative_path)){await ctx.store.ensureDirs();blob=await ctx.store.putStream(opened.handle.createReadStream({autoClose:false,signal:ctx.signal}),HISTORY_CONTENT_MAX_BYTES);sha256=blob.sha256;read=blob.sizeBytes;}
     else{const hash=createHash('sha256');for await(const chunk of opened.handle.createReadStream({autoClose:false,signal:ctx.signal})){ctx.throwIfStopped();hash.update(chunk);read+=chunk.length;}sha256=hash.digest('hex');}
     await assertUnchanged(opened,read);results.push({old,sha256,at:new Date(),blob});bytes+=read;
    }finally{await opened.handle.close();}
   }catch(error){ctx.throwIfStopped();if(isStorageFull(error))throw error;errors.push('file_unstable:'+old.relative_path);}
   await ctx.reportProgress?.({phase:'processing',completed:++processed,total:candidates.length,unit:'files'});
  }
 }catch(error){ctx.throwIfStopped();if(isStorageFull(error))throw error;errors.push('root_unavailable');}
 await ctx.complete(async db=>{
  if(!await stillCurrent(db,row,ctx))return;const now=new Date(),changed:IHistoryFileInput[]=[],records:IVersionRecord[]=[],accepted:IObservation[]=[],saved:{current:IObservation;blob:IStoredBlob}[]=[];
  for(const result of results){const current=(await db.query<IObservation>('SELECT * FROM tender_history_observation WHERE binding_id=$1 AND path_key=$2 FOR UPDATE',[row.binding_id,result.old.path_key])).rows[0];
   if(!current?.present||current.file_id!==result.old.file_id||current.mtime_ms!==result.old.mtime_ms||current.size_bytes!==result.old.size_bytes)continue;
   const next={...current,sha256:result.sha256,verified_at:result.at,status:'ok'};accepted.push(next);changed.push(fileInput(next));
   const previous=current.sha256?{sha256:current.sha256,id:current.file_id}:(await db.query<{sha256:string;id:string}>(`SELECT f.sha256,f.id FROM tender_history_file f JOIN tender_history_import i ON i.id=f.import_id WHERE f.binding_id=$1 AND f.path_key=$2 AND f.id<>$3 AND f.sha256 IS NOT NULL ORDER BY i.created_at DESC,f.verified_at DESC NULLS LAST,f.id DESC LIMIT 1`,[row.binding_id,current.path_key,current.file_id])).rows[0];
   if(previous&&previous.sha256!==result.sha256)records.push(event('file_content_changed',current.relative_path,ctx.job.id,'Подтверждено изменение содержимого.\nSHA-256 до: '+previous.sha256+'\nSHA-256 после: '+result.sha256,now,{beforeFileId:previous.id}));
   if(result.blob){await insertBlob(db,{...result.blob,mediaType:historyContentMediaType(current.relative_path)});saved.push({current,blob:result.blob});}
  }
  const ids=await publish(db,ctx,row,start,now,changed,records);for(const o of accepted)o.file_id=ids.get(o.path_key)??o.file_id;
  for(const {current,blob} of saved){const fileIds=[ids.get(current.path_key)!,...(!current.sha256||current.sha256===blob.sha256?[current.file_id]:[])];for(const fileId of new Set(fileIds))await db.query(`INSERT INTO tender_history_content(file_id,blob_sha256,provenance) VALUES($1,$2,'watch') ON CONFLICT(file_id) DO NOTHING`,[fileId,blob.sha256]);}
  await saveObservations(db,row.binding_id,accepted);await scanLog(db,ctx,row,'verify',start,errors.length===0,candidates.length,records.length,accepted.length,errors);
  if(errors.length)await db.query("UPDATE tender_history_watch SET last_error_code='history_verify_incomplete' WHERE binding_id=$1",[row.binding_id]);
 },async db=>{if(results.length&&errors.length===0)await enqueueJob(db,{kind:'history.verify',dedupeKey:'history-verify:'+row.binding_id,payload:{bindingId:row.binding_id},tenderId:row.tender_id,resourceClass:'network',priority:5});});
}};
