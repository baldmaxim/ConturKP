// S18-26: порядок загрузки образца и документа не блокирует распознавание тех же байтов.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { backupRoleProblems, restoreSafetyProblems } from '../packages/db/src/backup.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { contractDocx, smetaStromynkaXlsx, uniqueCopy } from './localFixtures.ts';

let db:ITestDb,s:IScenario,worker:ReturnType<typeof makeWorker>;
const config=testConfig(),octet={'Content-Type':'application/octet-stream'};
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,config));worker=makeWorker(db,config);});
afterAll(async()=>{await db?.drop();});
const upload=async(name:string,bytes:Buffer)=>{
 const accepted=await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent(name)}`,bytes,{headers:{...octet,...idem()}});
 expect(accepted.status,accepted.text).toBe(202);await drain(worker);
 const batch=await s.eng1.get(`/imports/${accepted.body.id}`);expect(batch.status,batch.text).toBe(200);
 expect(batch.body.items[0].documentRevisionId,JSON.stringify(batch.body)).toBeTruthy();return batch.body.items[0].documentRevisionId as string;
};
const sample=async(name:string,bytes:Buffer)=>{
 const r=await s.manager.post(`/form-samples?tenderId=${s.tenderA}&name=${encodeURIComponent(name)}`,bytes,{headers:{...octet,...idem()}});
 expect(r.status,r.text).toBe(201);return r.body.sha256 as string;
};
const blob=async(sha:string)=>(await db.pool.query('SELECT * FROM blob WHERE sha256=$1',[sha])).rows[0];
const format=async(sha:string)=>(await db.pool.query<{format:string|null}>('SELECT blob_local_input_format($1) AS format',[sha])).rows[0]!.format;

it('резервная копия: добавление деклараций не нарушает права чтения и восстановимость дампа',async()=>{
 expect(await backupRoleProblems(db.pool)).toEqual([]);
 expect(await restoreSafetyProblems(db.pool)).toEqual([]);
});

it.each([
 ['docx',()=>contractDocx()],['xlsx',()=>smetaStromynkaXlsx()],
] as const)('%s: образец раньше импорта; исходный blob неизменен, распознавание и повтор работают',async(kind,makeBytes)=>{
 const bytes=uniqueCopy(makeBytes(),'zip'),sha=createHash('sha256').update(bytes).digest('hex'),name=`Образец.${kind}`;
 expect(await sample(name,bytes)).toBe(sha);const before=await blob(sha);expect(before.media_type).toBe('application/octet-stream');expect(await format(sha)).toBeNull();
 const revision=await upload(name,bytes);expect(await format(sha)).toBe(kind);expect(await blob(sha)).toEqual(before);
 expect(await worker.scheduleLocalRecognition()).toBeGreaterThan(0);await drain(worker);
 const runs=await s.eng1.get(`/document-revisions/${revision}/recognition-runs`);expect(runs.status,runs.text).toBe(200);expect(runs.body.items[0]).toMatchObject({status:'complete',engine:'local_ocr'});
 const fragments=await s.eng1.get(`/recognition-runs/${runs.body.items[0].id}/fragments?pageIndex=0`);expect(fragments.body.items.length).toBeGreaterThan(0);
 expect(await upload(name,bytes)).toBe(revision);expect((await db.pool.query('SELECT 1 FROM blob_format_declaration WHERE blob_sha256=$1',[sha])).rowCount).toBe(1);expect(await blob(sha)).toEqual(before);
 const forbidden=await s.eng3.get(`/document-revisions/${revision}/recognition-runs`);expect(forbidden.status).toBe(404);
 await expect(db.pool.query("UPDATE blob SET media_type='text/csv' WHERE sha256=$1",[sha])).rejects.toBeTruthy();expect(await blob(sha)).toEqual(before);
 await expect(db.pool.query("DELETE FROM blob_format_declaration WHERE blob_sha256=$1",[sha])).rejects.toBeTruthy();expect(await format(sha)).toBe(kind);
});
it('сначала документ, затем образец: конкретный MIME не заменяется общим',async()=>{
 const bytes=uniqueCopy(contractDocx(),'zip'),sha=createHash('sha256').update(bytes).digest('hex');await upload('Документ.docx',bytes);const before=await blob(sha);
 await sample('Образец.docx',bytes);expect(await blob(sha)).toEqual(before);expect(await format(sha)).toBe('docx');
});
it('общий MIME без подтверждения и несовместимые декларации не угадывают формат',async()=>{
 const sha=randomBytes(32).toString('hex');await db.pool.query("INSERT INTO blob(sha256,size_bytes,media_type,storage_key) VALUES($1,1,'application/octet-stream',$2)",[sha,'fixture/'+sha]);
 expect(await format(sha)).toBeNull();
 await db.pool.query("INSERT INTO blob_format_declaration(blob_sha256,media_type) VALUES($1,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')",[sha]);expect(await format(sha)).toBe('docx');
 await db.pool.query("INSERT INTO blob_format_declaration(blob_sha256,media_type) VALUES($1,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')",[sha]);expect(await format(sha)).toBeNull();
 await expect(db.pool.query("INSERT INTO blob_format_declaration(blob_sha256,media_type) VALUES($1,'application/zip')",[sha])).rejects.toBeTruthy();
});
