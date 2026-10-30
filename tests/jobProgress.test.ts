import { afterAll, beforeAll, expect, it } from 'vitest';
import { claimJob, enqueueJob, reportJobProgress, releaseJob, requestCancel, officeSnapshot, getJob } from '../packages/db/src/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
let db:ITestDb;
const value={phase:'processing',completed:3,total:10,unit:'files'} as const;
const claim=(kind:string)=>claimJob(db.pool,{workerId:'progress-test',leaseMs:60000,gpuGraceMs:0,kinds:[kind]});
beforeAll(async()=>{db=await createTestDb();});
afterAll(async()=>db.drop());
it('старый токен и отменённое задание не меняют прогресс; новая попытка обнуляет его',async()=>{
  const {id}=await enqueueJob(db.pool,{kind:'test.progress'}),a=(await claim('test.progress'))!;
  expect(await reportJobProgress(db.pool,id,a.lease_token!,value)).toBe(true);
  await releaseJob(db.pool,a,a.lease_token!,{code:'retry',message:'retry',delayMs:0,refundAttempt:false});
  const b=(await claim('test.progress'))!;
  expect((await db.pool.query('SELECT progress FROM job WHERE id=$1',[id])).rows[0].progress).toBeNull();
  expect(await reportJobProgress(db.pool,id,a.lease_token!,value)).toBe(false);
  await requestCancel(db.pool,id);
  expect(await reportJobProgress(db.pool,id,b.lease_token!,value)).toBe(false);
  await expect(reportJobProgress(db.pool,id,b.lease_token!,{...value,completed:11})).rejects.toThrow('invalid_job_progress');
});
it('runtime сообщает обработку и сохранение, завершение убирает задачу из снимка',async()=>{
  const {id}=await enqueueJob(db.pool,{kind:'test.runtime-progress'}),job=(await claim('test.runtime-progress'))!,config=testConfig();
  const worker=new WorkerRuntime({pool:db.pool,config,store:new BlobStore(config.storageRoot),handlers:{'test.runtime-progress':async ctx=>{
    await ctx.reportProgress!({...value,completed:4});
    expect((await officeSnapshot(db.pool,[])).tasks.find(t=>t.id===id)?.progress?.completed).toBe(4);
    await ctx.complete(async client=>{expect((await client.query('SELECT progress FROM job WHERE id=$1',[id])).rows[0].progress.phase).toBe('saving');});
  }}});
  await worker.execute(job);
  expect((await getJob(db.pool,id))?.status).toBe('succeeded');
  expect((await officeSnapshot(db.pool,[])).tasks.some(t=>t.id===id)).toBe(false);
});
