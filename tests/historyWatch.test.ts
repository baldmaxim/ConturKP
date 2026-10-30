import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,statSync,unlinkSync,renameSync,symlinkSync,utimesSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {buildScenario,createTestDb,drain,idem,makeApp,makeWorker,testConfig,type IScenario,type ITestDb} from './helpers.ts';
import {enqueueJob} from '../packages/db/src/jobs.ts';
import {nightlyHistoryCutoff,scheduleHistoryWatch} from '../apps/worker/src/handlers/historyWatch.ts';
import {walkHistoryRoot} from '../apps/worker/src/handlers/historyWalk.ts';
const base=mkdtempSync(join(tmpdir(),'kontur-watch-')),root=join(base,'tender');mkdirSync(root);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const file=join(root,'ВОР.txt');writeFileSync(file,'old');
const config=testConfig({historyWatchRoots:[root]});
let db:ITestDb,s:IScenario,bindingId:string;
beforeAll(async()=>{
 db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,config));
 const report=JSON.stringify({folders:[{id:'330. Пример',tender_id:'watch-folder',tender:true}],snapshot:{started_at:'2026-10-23T10:00:00Z',finished_at:'2026-10-23T10:35:00Z',complete:true},events:[],files:[{p:'330. Пример/ВОР.txt',tender_id:'watch-folder',s:3,h:hash('old'),m:statSync(file).mtime.toISOString(),end:new Date().toISOString(),st:'ok'}]});
 const r=await s.manager.post('/tenders/'+s.tenderA+'/history-import?name=history.json&folderId=watch-folder&confirmBinding=true',Buffer.from(report),{headers:{...idem(),'Content-Type':'application/octet-stream'}});expect(r.status,r.text).toBe(200);bindingId=r.body.bindingId;
 await db.pool.query('INSERT INTO tender_history_watch(binding_id,root_path,configured_by,stability_seconds) VALUES($1,$2,$3,0)',[bindingId,root,s.ids.manager]);
});
afterAll(async()=>{await db?.drop();});
const run=async(mode:'scan'|'verify')=>{await enqueueJob(db.pool,{kind:'history.'+mode,payload:{bindingId},dedupeKey:'test:'+randomUUID(),tenderId:s.tenderA,resourceClass:'network'});await drain(makeWorker(db,config));};
const feed=async()=>JSON.stringify((await s.manager.get('/history')).body);
const count=async()=>Number((await db.pool.query('SELECT count(*) n FROM tender_history_import')).rows[0]!.n);
describe('прямое наблюдение Tender',()=>{
 it('планирование переживает повтор и создаёт только два вида заданий',async()=>{
  expect(await scheduleHistoryWatch(db.pool)).toBe(2);expect(await scheduleHistoryWatch(db.pool)).toBe(0);await drain(makeWorker(db,config));
  expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_observation')).rows[0]!.n).toBe(1);
 });
 it('неизменный обход не размножает снимки, сохраняет исходный SHA и дату его проверки',async()=>{
  const before=await count();await run('scan');expect(await count()).toBe(before);
  const r=await s.manager.get('/history/files');expect(r.body.items[0]).toMatchObject({sha256:hash('old'),path:'ВОР.txt',status:'ok'});
  expect((await s.manager.get('/history/summary')).body.watch[0]).toMatchObject({enabled:true,lastErrorCode:null});
 });
 it('создаёт событие нового пути, затем проверяет байты без массового импорта документов',async()=>{
  const docs=(await db.pool.query('SELECT count(*) n FROM document_revision')).rows[0]!.n;
  writeFileSync(join(root,'новый.txt'),'new');await run('scan');expect(await feed()).toContain('file_added');
  expect((await s.manager.get('/history/tasks')).body.items.some((t:{title:string})=>t.title.startsWith('Проверить изменения:'))).toBe(true);
  let item=(await s.manager.get('/history/files')).body.items.find((f:{path:string})=>f.path==='новый.txt');expect(item.sha256).toBe(null);
  await run('verify');item=(await s.manager.get('/history/files')).body.items.find((f:{path:string})=>f.path==='новый.txt');expect(item.sha256).toBe(hash('new'));
  expect((await db.pool.query('SELECT count(*) n FROM document_revision')).rows[0]!.n).toBe(docs);
  const before=await count();await run('verify');expect(await count()).toBe(before);
 });
 it('изменение метаданных сбрасывает подтверждение содержимого и ждёт стабильности',async()=>{
  writeFileSync(file,'longer');utimesSync(file,new Date('2026-10-23T12:00:00Z'),new Date('2026-10-23T12:00:00Z'));await run('scan');expect(await feed()).toContain('file_modified');
  const metadata=(await s.manager.get('/history')).body.items.find((e:{kind:string})=>e.kind==='file_modified');
  expect(metadata.detail).toContain('Размер: 3 → 6 байт.');expect(metadata.sourcePath).toBe('ВОР.txt');
  expect(metadata.fileChange).toMatchObject({before:{size:3,sha256:hash('old')},after:{size:6,sha256:null}});
  await db.pool.query('UPDATE tender_history_watch SET stability_seconds=60 WHERE binding_id=$1',[bindingId]);await run('verify');
  expect((await db.pool.query('SELECT sha256 FROM tender_history_observation WHERE relative_path=$1',['ВОР.txt'])).rows[0]!.sha256).toBe(null);
  await db.pool.query("UPDATE tender_history_observation SET stable_since=now()-interval '2 minutes'");await run('verify');
  expect((await db.pool.query('SELECT sha256 FROM tender_history_observation WHERE relative_path=$1',['ВОР.txt'])).rows[0]!.sha256).toBe(hash('longer'));
  const content=(await s.manager.get('/history')).body.items.find((e:{kind:string})=>e.kind==='file_content_changed');
  expect(content.detail).toContain(hash('old'));expect(content.detail).toContain(hash('longer'));
  const stableCount=await count();await run('verify');expect(await count()).toBe(stableCount);
 });
 it('новое время файла при прежних байтах не выдаётся за изменение содержимого',async()=>{
  const before=(await db.pool.query("SELECT count(*)::int n FROM tender_history_record WHERE kind='file_content_changed'")).rows[0]!.n;
  const st=statSync(file);utimesSync(file,st.atime,new Date(st.mtimeMs+86400_000));await run('scan');
  await db.pool.query("UPDATE tender_history_observation SET stable_since=now()-interval '2 minutes'");await run('verify');
  expect((await db.pool.query("SELECT count(*)::int n FROM tender_history_record WHERE kind='file_content_changed'")).rows[0]!.n).toBe(before);
 });
 it('ночная сверка обнаруживает подмену содержимого с сохранёнными размером и mtime',async()=>{
  const st=statSync(file);writeFileSync(file,'hidden');utimesSync(file,st.atime,st.mtime);
  await db.pool.query("UPDATE tender_history_observation SET verified_at='2026-01-01',stable_since='2026-01-01'");await run('verify');
  expect(await feed()).toContain('file_content_changed');
  expect((await db.pool.query('SELECT sha256 FROM tender_history_observation WHERE relative_path=$1',['ВОР.txt'])).rows[0]!.sha256).toBe(hash('hidden'));
  const id=(await db.pool.query("SELECT id FROM tender_history_record WHERE kind='file_content_changed' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0]!.id;
  const comparison=await s.manager.get('/history/records/'+id+'/comparison');expect(comparison.status,comparison.text).toBe(200);expect(comparison.body.changes).toMatchObject([{before:'longer',after:'hidden'}]);
 });
 it('недоступный корень не означает удаление и не портит последний успешный обход',async()=>{
  const before=(await db.pool.query('SELECT last_success_at FROM tender_history_watch')).rows[0]!.last_success_at;
  renameSync(root,root+'-offline');try{await run('scan');}finally{renameSync(root+'-offline',root);}
  expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_observation WHERE present')).rows[0]!.n).toBe(2);
  expect((await db.pool.query('SELECT last_success_at,last_error_code FROM tender_history_watch')).rows[0]).toEqual({last_success_at:before,last_error_code:'history_root_unavailable'});
 });
 it('фиксирует отсутствие после двух полных обходов и восстановление отдельным событием',async()=>{
  unlinkSync(join(root,'новый.txt'));await run('scan');expect(await feed()).not.toContain('file_missing');
  await run('scan');expect(await feed()).toContain('file_missing');
  expect((await db.pool.query("SELECT present FROM tender_history_observation WHERE relative_path='новый.txt'")).rows[0]!.present).toBe(false);
  writeFileSync(join(root,'новый.txt'),'new');await run('scan');expect(await feed()).toContain('file_restored');
 });
 it('быстрый отказ записывается при опережении часов процесса и не откатывает статус подключения',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.now()+1000));renameSync(root,root+'-offline');
  try{await run('scan');}finally{renameSync(root+'-offline',root);vi.useRealTimers();}
  const scan=(await db.pool.query("SELECT complete,finished_at>=started_at AS ordered FROM tender_history_scan WHERE mode='scan' ORDER BY finished_at DESC LIMIT 1")).rows[0];
  expect(scan).toEqual({complete:false,ordered:true});
  expect((await db.pool.query('SELECT last_error_code FROM tender_history_watch')).rows[0]!.last_error_code).toBe('history_root_unavailable');
 });
 it('не следует по junction и не считает ограниченный обход полным',async()=>{
  const outside=join(base,'outside');mkdirSync(outside);writeFileSync(join(outside,'секрет.txt'),'private');symlinkSync(outside,join(root,'link'),'junction');
  const walked=await walkHistoryRoot(root,()=>undefined);expect(walked.complete).toBe(false);expect(walked.files.some(f=>f.path.includes('секрет'))).toBe(false);
  await run('scan');expect((await db.pool.query('SELECT last_error_code FROM tender_history_watch')).rows[0]!.last_error_code).toBe('history_scan_incomplete');
  const limited=await walkHistoryRoot(outside,()=>undefined,{files:0,entries:1,depth:1});expect(limited.complete).toBe(false);
 });
 it('приостановка защищена правами и If-Match, очередь после неё не читает папку',async()=>{
  const route='/tenders/'+s.tenderA+'/history-watch';
  expect((await s.eng1.put(route,{bindingId,enabled:false},{headers:{'If-Match':'"'+bindingId+':1"'}})).status).toBe(403);
  expect((await s.manager.put(route,{bindingId,enabled:false},{headers:{'If-Match':'"'+bindingId+':1"'}})).status).toBe(200);
  expect((await s.manager.put(route,{bindingId,enabled:true},{headers:{'If-Match':'"'+bindingId+':1"'}})).status).toBe(412);
  const before=await count();await run('scan');expect(await count()).toBe(before);
 });
 it('общая папка 341/341.1 видна через связь только при доступе к обеим карточкам',async()=>{
  await db.pool.query('INSERT INTO tender_history_related(binding_id,tender_id,reason,created_by) VALUES($1,$2,$3,$4)',[bindingId,s.tenderB,'Общая физическая папка',s.ids.manager]);
  const own=await s.manager.get('/history/files?tenderId='+s.tenderB);expect(own.body.items.length).toBeGreaterThan(0);
  const projects=(await s.manager.get('/history/summary')).body.changedProjects;
  const relatedPage=(await s.manager.get('/history?tenderId='+s.tenderB+'&limit=100')).body.items;
  expect(projects.find((p:{tenderId:string})=>p.tenderId===s.tenderB).changes).toBe(relatedPage.length);
  for(const path of ['/history','/history/files']){
   const single=await s.manager.get(path+'?tenderId='+s.tenderB+'&limit=100');
   const combined=await s.manager.get(path+'?tenderId='+s.tenderA+'&tenderId='+s.tenderB+'&limit=100');expect(combined.status,combined.text).toBe(200);
   expect(combined.body.items.map((e:{id:string})=>e.id)).toEqual(single.body.items.map((e:{id:string})=>e.id));
   expect(new Set(combined.body.items.map((e:{id:string})=>e.id)).size).toBe(combined.body.items.length);
  }
  expect((await s.eng3.get('/history/summary')).body.changedProjects).toEqual([]);
  expect((await s.eng3.get('/history/files?tenderId='+s.tenderB)).body.items).toEqual([]);
  expect((await s.eng3.get('/history/summary?tenderId='+s.tenderB)).body.related).toEqual([]);
  await db.pool.query("UPDATE tender SET status='archived', outcome='won' WHERE id=$1",[s.tenderA]);
  try{
   expect((await s.manager.get('/history/files?tenderId='+s.tenderB)).body.items).toEqual([]);
   expect((await s.manager.get('/history/summary?tenderId='+s.tenderB)).body.related).toEqual([]);
  }finally{await db.pool.query("UPDATE tender SET status='active', outcome=NULL WHERE id=$1",[s.tenderA]);}
 });
 it('очередь повторно проверяет полномочия владельца подключения',async()=>{
  await db.pool.query('UPDATE tender_history_watch SET enabled=true,configured_by=$2 WHERE binding_id=$1',[bindingId,s.ids.eng1]);
  const before=await count();await run('scan');expect(await count()).toBe(before);
  expect((await db.pool.query('SELECT last_error_code FROM tender_history_watch')).rows[0]!.last_error_code).toBe('history_access_revoked');
  await db.pool.query('UPDATE tender_history_watch SET configured_by=$2 WHERE binding_id=$1',[bindingId,s.ids.manager]);
 });
 it('не читает подставленный путь вне разрешённого корня',async()=>{
  await db.pool.query('UPDATE tender_history_watch SET root_path=$2 WHERE binding_id=$1',[bindingId,join(base,'outside')]);
  const before=await count();await run('scan');expect(await count()).toBe(before);
  expect((await db.pool.query('SELECT last_error_code FROM tender_history_watch')).rows[0]!.last_error_code).toBe('history_root_not_allowed');
 });
 it('граница ночной сверки задана на 02:00 МСК',()=>{
  expect(nightlyHistoryCutoff(new Date('2026-10-24T00:00:00Z')).toISOString()).toBe('2026-10-23T23:00:00.000Z');
  expect(nightlyHistoryCutoff(new Date('2026-10-23T22:00:00Z')).toISOString()).toBe('2026-10-22T23:00:00.000Z');
 });
});
