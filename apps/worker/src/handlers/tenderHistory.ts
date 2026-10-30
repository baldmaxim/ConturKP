import { Readable } from 'node:stream';
import { dirname,resolve } from 'node:path';
import { lstat,realpath } from 'node:fs/promises';
import { prepareLegacyHistory,readLegacyHistory } from '@kontur/core';
import { canManageHistory,enqueueJob,importTenderHistory,insertBlob,loadAccessContext,withTransaction,writeAudit,type Pool } from '@kontur/db';
import { PermanentJobError,RetryableJobError,type IJobHandlerSpec } from '../runtime.ts';
import { assertUnchanged,openVerifiedFile } from './safeRead.ts';

export const scheduleHistorySync=async(pool:Pool):Promise<number>=>{
  const rows=(await pool.query(`SELECT s.binding_id,b.tender_id FROM tender_history_sync s JOIN tender_history_binding b ON b.id=s.binding_id
    WHERE s.enabled AND(s.last_scheduled_at IS NULL OR s.last_scheduled_at<now()-interval '5 minutes')`)).rows;
  for(const row of rows)await withTransaction(pool,async(db)=>{
    await enqueueJob(db,{kind:'history.sync',dedupeKey:'history-sync:'+row.binding_id,payload:{bindingId:row.binding_id},tenderId:row.tender_id,resourceClass:'network'});
    await db.query('UPDATE tender_history_sync SET last_scheduled_at=now() WHERE binding_id=$1',[row.binding_id]);
  });
  return rows.length;
};
export const historySyncHandler:IJobHandlerSpec={
  run:async(ctx)=>{
    const bindingId=String(ctx.job.payload.bindingId);
    const row=(await ctx.pool.query(`SELECT s.*,b.tender_id,b.external_folder_id FROM tender_history_sync s JOIN tender_history_binding b ON b.id=s.binding_id
      WHERE s.binding_id=$1 AND s.enabled`,[bindingId])).rows[0];
    if(!row)return;
    if(!(ctx.config.historyReportPaths??[]).includes(row.report_path))throw new PermanentJobError('history_source_not_allowed','Источник хронологии не разрешён');
    const access=await loadAccessContext(ctx.pool,row.configured_by,'history-sync:'+ctx.job.id);
    if(!access||!canManageHistory(access,row.tender_id))throw new PermanentJobError('history_access_revoked','Отозваны права на подключение хронологии');
    let text:string,source:ReturnType<typeof readLegacyHistory>;
    try {
      const st=await lstat(row.report_path);
      if(!st.isFile()||st.isSymbolicLink()||st.size>40*1024*1024)throw new Error('Недопустимый файл отчёта');
      const parent=await realpath(dirname(resolve(row.report_path)));
      const verified=await openVerifiedFile(row.report_path,parent,{size:st.size,mtimeMs:Math.trunc(st.mtimeMs)});
      try{
        text=await verified.handle.readFile({encoding:'utf8'});
        await assertUnchanged(verified,Buffer.byteLength(text));
        source=readLegacyHistory(text);
      }finally{await verified.handle.close();}
    }catch{
      await ctx.withLease(db=>db.query("UPDATE tender_history_sync SET last_checked_at=now(),last_error_code='history_report_unavailable' WHERE binding_id=$1",[bindingId]).then(()=>undefined));
      throw new RetryableJobError('history_report_unavailable','Отчёт недоступен, изменился при чтении или не прошёл проверку формата');
    }
    ctx.throwIfStopped();
    const manifest=prepareLegacyHistory(source,row.external_folder_id,row.tender_id===null);
    await ctx.store.ensureDirs();
    const stored=await ctx.store.putStream(Readable.from([Buffer.from(text)]),40*1024*1024);
    await ctx.complete(async(db)=>{
      const current=(await db.query('SELECT enabled,row_version FROM tender_history_sync WHERE binding_id=$1 FOR UPDATE',[bindingId])).rows[0];
      if(!current?.enabled||current.row_version!==row.row_version)return;
      const fresh=await loadAccessContext(db,row.configured_by,'history-sync:'+ctx.job.id);
      if(!fresh||!canManageHistory(fresh,row.tender_id))throw new PermanentJobError('history_access_revoked','Отозваны права на подключение хронологии');
      await insertBlob(db,{sha256:stored.sha256,sizeBytes:stored.sizeBytes,storageKey:stored.storageKey,mediaType:'application/octet-stream'});
      const result=await importTenderHistory(db,fresh,row.tender_id,manifest);
      await db.query('UPDATE tender_history_sync SET last_checked_at=now(),last_success_at=now(),last_error_code=NULL WHERE binding_id=$1',[bindingId]);
      if(!result.repeated)await writeAudit(db,{actorUserId:null,principalKind:'system',action:'tender.history.sync',entityType:'tender_history_binding',entityId:bindingId,tenderId:row.tender_id,requestId:'history-sync:'+ctx.job.id,outcome:'allowed',details:{importId:result.importId,artifactSha256:stored.sha256,recordsAdded:result.recordsAdded,filesAdded:result.filesAdded}});
    });
  },
  onTerminalFailure:async(db,ctx,failure)=>{
    await db.query('UPDATE tender_history_sync SET last_checked_at=now(),last_error_code=$2 WHERE binding_id=$1',[String(ctx.job.payload.bindingId),failure.code]);
  },
};
