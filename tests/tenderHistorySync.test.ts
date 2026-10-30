import { mkdtempSync,writeFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { historyDigest } from '../packages/core/src/tenderHistory.ts';
import { buildScenario,createTestDb,drain,idem,makeApp,makeWorker,testConfig,type IScenario,type ITestDb } from './helpers.ts';
import { scheduleHistorySync } from '../apps/worker/src/handlers/tenderHistory.ts';

const dir=mkdtempSync(join(tmpdir(),'kontur-history-')),file=join(dir,'chronology.html');
const config=testConfig({historyReportPaths:[file]});
const report=(title:string)=>JSON.stringify({
  folders:[{id:'330. Пример',tender_id:'folder-1',tender:true}],
  snapshot:{started_at:'2026-10-23T10:00:00Z',finished_at:'2026-10-23T10:35:00Z',complete:true},
  events:[{id:'record-1',tender_id:'folder-1',folder:'330. Пример',kind:'note',title,summary:'Заметка',at:'2026-10-22T10:00:00Z'}],
  files:[],
});
let db:ITestDb,s:IScenario,bindingId:string;
beforeAll(async()=>{
  db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,config));
  writeFileSync(file,report('Первая запись'));
  const r=await s.manager.post('/tenders/'+s.tenderA+'/history-import?name=chronology.json&folderId=folder-1&confirmBinding=true',Buffer.from(report('Первая запись')),{headers:{...idem(),'Content-Type':'application/octet-stream'}});
  expect(r.status,r.text).toBe(200);bindingId=r.body.bindingId;
});
afterAll(async()=>{await db?.drop();try{unlinkSync(file);}catch{/* already absent */}});
const setting=(enabled:boolean,version:number,sourceKey=historyDigest(file))=>s.manager.put('/tenders/'+s.tenderA+'/history-sync',{bindingId,sourceKey,enabled},{headers:{'If-Match':'"'+bindingId+':'+version+'"'}});
const due=()=>db.pool.query('UPDATE tender_history_sync SET last_scheduled_at=NULL,last_success_at=NULL');

describe('фоновое чтение разрешённого отчёта',()=>{
  it('показывает разрешённые названия без UNC-путей, требует подтверждённую привязку и версию',async()=>{
    const sources=await s.manager.get('/tenders/'+s.tenderA+'/history-report-sources');
    expect(sources.body).toEqual({items:[{key:historyDigest(file),label:'chronology.html'}]});
    expect((await setting(true,0,'a'.repeat(64))).status).toBe(400);
    expect((await setting(true,0)).status).toBe(200);
    expect((await setting(false,0)).status).toBe(412);
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history-report-sources')).status).toBe(403);
  });
  it('планирует одно задание и переносит новую редакцию без открытия браузера',async()=>{
    writeFileSync(file,report('Новая запись'));
    expect(await scheduleHistorySync(db.pool)).toBe(1);
    expect(await scheduleHistorySync(db.pool)).toBe(0);
    await drain(makeWorker(db,config));
    const rows=await s.eng1.get('/tenders/'+s.tenderA+'/history');
    expect(rows.body.items.find((r:{title:string})=>r.title==='Новая запись')).toMatchObject({revision:2});
    const summary=await s.eng1.get('/tenders/'+s.tenderA+'/history-summary');
    expect(summary.body.sync[0]).toMatchObject({enabled:true,lastErrorCode:null});
    expect(summary.body.sync[0].lastSuccessAt).toBeTruthy();
    expect(JSON.stringify(summary.body)).not.toContain(dir);
  });
  it('неизменный отчёт не создаёт импорт и ревизию повторно',async()=>{
    const count=(await db.pool.query('SELECT count(*)::int n FROM tender_history_import')).rows[0]!.n;
    await due();await scheduleHistorySync(db.pool);await drain(makeWorker(db,config));
    expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_import')).rows[0]!.n).toBe(count);
  });
  it('недоступный отчёт даёт явную ошибку, прежняя история сохраняется',async()=>{
    unlinkSync(file);await due();await scheduleHistorySync(db.pool);await makeWorker(db,config).runOnce();
    const summary=await s.eng1.get('/tenders/'+s.tenderA+'/history-summary');
    expect(summary.body.sync[0].lastErrorCode).toBe('history_report_unavailable');
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history')).body.items.some((r:{title:string})=>r.title==='Новая запись')).toBe(true);
  });
  it('выключенное подключение не планируется',async()=>{
    expect((await setting(false,1)).status).toBe(200);
    await due();expect(await scheduleHistorySync(db.pool)).toBe(0);
  });
  it('отзыв назначения останавливает чтение от имени прежнего руководителя',async()=>{
    writeFileSync(file,report('Не должно импортироваться'));expect((await setting(true,2)).status).toBe(200);
    await db.pool.query('UPDATE tender_member SET removed_at=now(),removed_by=$3 WHERE tender_id=$1 AND user_id=$2 AND removed_at IS NULL',[s.tenderA,s.ids.manager,s.ids.admin]);
    // The existing delayed retry is made due; it must recheck current rights.
    await db.pool.query("UPDATE job SET run_after=now() WHERE kind='history.sync' AND status='queued'");
    await due();await scheduleHistorySync(db.pool);await drain(makeWorker(db,config));
    expect((await db.pool.query("SELECT count(*)::int n FROM tender_history_record WHERE title='Не должно импортироваться'")).rows[0]!.n).toBe(0);
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history-summary')).body.sync[0].lastErrorCode).toBe('history_access_revoked');
  });
});
