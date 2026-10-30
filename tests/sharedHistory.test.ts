import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {readLegacyHistory,prepareLegacyHistory} from '../packages/core/src/tenderHistory.ts';
import {importTenderHistory,loadAccessContext,withTransaction,enqueueJob} from '../packages/db/src/index.ts';
import {buildScenario,createTestDb,drain,idem,makeApp,makeWorker,testConfig,type IScenario,type ITestDb} from './helpers.ts';
const base=mkdtempSync(join(tmpdir(),'shared-history-')),conditions=join(base,'conditions'),templates=join(base,'templates');
mkdirSync(conditions);mkdirSync(templates);mkdirSync(join(templates,'Папка шаблона'));writeFileSync(join(conditions,'условия.docx'),'one');writeFileSync(join(conditions,'приложение.docx'),'two');
const config=testConfig({historyWatchRoots:[base]});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const report=()=>JSON.stringify({folders:[{id:'330. Тендер',tender_id:'private',tender:true},{id:'001 Условия',tender_id:'common',tender:false},{id:'000 Шаблоны',tender_id:'templates',tender:false}],
 snapshot:{started_at:'2026-10-23T10:00:00Z',finished_at:'2026-10-23T10:35:00Z',complete:true},
 events:[{id:'shared-note',folder:'001 Условия',tender_id:'common',kind:'note',title:'Общие условия',summary:'Общий материал',at:'2026-10-23T10:00:00Z'},
 {id:'private-note',folder:'330. Тендер',tender_id:'private',kind:'note',title:'Закрытые сведения A',summary:'Доступ только участнику A',at:'2026-10-23T10:00:00Z'}],
 files:[...['условия.docx','приложение.docx'].map((p,i)=>({p:'001 Условия/'+p,tender_id:'common',s:3,h:hash(i?'two':'one'),m:statSync(join(conditions,p)).mtime.toISOString(),end:'2026-10-24T08:00:00Z',st:'ok'})),
 {p:'330. Тендер/секрет.docx',tender_id:'private',s:3,h:hash('private'),st:'ok'}]});
let db:ITestDb,s:IScenario,commonId:string,templateId:string;
beforeAll(async()=>{
 db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,config));
 await db.pool.query("INSERT INTO user_role(user_id,role) VALUES($1,'manager')",[s.ids.admin]);
 await withTransaction(db.pool,async client=>{
  const ctx=(await loadAccessContext(client,s.ids.admin,'test-shared'))!;
  commonId=(await importTenderHistory(client,ctx,null,prepareLegacyHistory(readLegacyHistory(report()),'common',true))).bindingId;
  templateId=(await importTenderHistory(client,ctx,null,prepareLegacyHistory(readLegacyHistory(report()),'templates',true))).bindingId;
  for(const [id,path] of [[commonId,conditions],[templateId,templates]])await client.query('INSERT INTO tender_history_watch(binding_id,root_path,configured_by,stability_seconds) VALUES($1,$2,$3,0)',[id,path,s.ids.admin]);
 });
 const r=await s.manager.post('/tenders/'+s.tenderA+'/history-import?name=history.json&folderId=private&confirmBinding=true',Buffer.from(report()),{headers:{...idem(),'Content-Type':'application/octet-stream'}});expect(r.status,r.text).toBe(200);
});
afterAll(async()=>{await db?.drop();});
const run=async(bindingId:string,mode='scan')=>{await enqueueJob(db.pool,{kind:'history.'+mode,payload:{bindingId},dedupeKey:randomUUID(),resourceClass:'network'});await drain(makeWorker(db,config));};
describe('общие источники вне тендеров',()=>{
 it('выбор нескольких проектов не подмешивает независимые общие материалы',async()=>{
  const selection='tenderId='+s.tenderA+'&tenderId='+s.tenderB;
  for(const path of ['/history','/history/files']){
   const page=await s.manager.get(path+'?'+selection);expect(page.status,page.text).toBe(200);expect(page.body.items.length).toBeGreaterThan(0);
   expect(page.body.items.every((e:{tenderId:string|null})=>e.tenderId===s.tenderA)).toBe(true);
  }
  const summary=await s.manager.get('/history/summary?'+selection);expect(summary.status,summary.text).toBe(200);
  expect(summary.body.bindings.map((b:{tenderId:string})=>b.tenderId)).toEqual([s.tenderA]);
  expect((await s.manager.get('/history?scope=common')).body.items.every((e:{tenderId:string|null})=>e.tenderId===null)).toBe(true);
 });
 it('исходные снимки и старые журналы Revit доступны отдельно от обычных изменений',async()=>{
  await withTransaction(db.pool,async client=>{
   const manifest=prepareLegacyHistory(readLegacyHistory(report()),'common',true);
   manifest.sourceSha256=hash('service-history');manifest.records=[
    {key:'original-snapshot',kind:'baseline',title:'Исходный снимок',detail:'',occurredAt:'2026-10-24T08:00:00Z',sourcePath:null,sourceLabel:'HTML',payloadSha256:hash('baseline'),restricted:false,technical:false},
    {key:'legacy-log',kind:'file_modified',title:'Журнал Revit',detail:'',occurredAt:'2026-10-24T08:00:00Z',sourcePath:'модель.slog',sourceLabel:'HTML',payloadSha256:hash('slog'),restricted:false,technical:false},
   ];
   await importTenderHistory(client,(await loadAccessContext(client,s.ids.admin,'service-history'))!,null,manifest);
  });
  const ordinary=JSON.stringify((await s.eng3.get('/history?scope=common')).body),service=JSON.stringify((await s.eng3.get('/history?scope=common&technical=true')).body);
  expect(ordinary).not.toContain('original-snapshot');expect(ordinary).not.toContain('Исходный снимок');expect(ordinary).not.toContain('модель.slog');
  expect(service).toContain('Исходный снимок');expect(service).toContain('модель.slog');
 });
 it('отдельно распознаёт общие группы; обычный импорт в тендер не принимает их',()=>{
  const source=readLegacyHistory(report());expect(source.folders).toHaveLength(1);expect(source.sharedFolders).toHaveLength(2);
  expect(()=>prepareLegacyHistory(source,'common')).toThrow();expect(prepareLegacyHistory(source,'common',true).files).toHaveLength(2);
 });
 it('создание общей привязки требует администратора с содержательной ролью; повтор без дублей',async()=>{
  await expect(withTransaction(db.pool,async client=>importTenderHistory(client,(await loadAccessContext(client,s.ids.manager,'denied'))!,null,prepareLegacyHistory(readLegacyHistory(report()),'common',true)))).rejects.toThrow('history_access_denied');
  const repeated=await withTransaction(db.pool,async client=>importTenderHistory(client,(await loadAccessContext(client,s.ids.admin,'repeat'))!,null,prepareLegacyHistory(readLegacyHistory(report()),'common',true)));
  expect(repeated.repeated).toBe(true);expect((await db.pool.query('SELECT tender_id FROM tender_history_binding WHERE id=$1',[commonId])).rows[0]!.tender_id).toBe(null);
 });
 it('инженер без назначения в A видит общие материалы, но не закрытые сведения A',async()=>{
  const feed=await s.eng3.get('/history');expect(JSON.stringify(feed.body)).toContain('Общие условия');expect(JSON.stringify(feed.body)).not.toContain('Закрытые сведения A');
  const files=await s.eng3.get('/history/files?scope=common');expect(files.body.items).toHaveLength(2);expect(files.body.items.every((f:{tenderId:string|null})=>f.tenderId===null)).toBe(true);
  expect((await s.admin.get('/history/files?scope=common')).body.items).toHaveLength(2);
  const projects=(await s.eng3.get('/history/summary?scope=common')).body.changedProjects;expect(projects).toHaveLength(1);expect(projects[0]).toMatchObject({tenderId:null,title:'Общие условия и шаблоны',changes:1});
  await db.pool.query("UPDATE tender SET status='archived', outcome='won' WHERE id=$1",[s.tenderA]);
  try{
   expect((await s.eng3.get('/history/files?scope=common')).body.items).toHaveLength(2);
   expect((await s.manager.get('/history/summary')).body.bindings.every((b:{tenderId:string|null})=>b.tenderId===null)).toBe(true);
  }finally{await db.pool.query("UPDATE tender SET status='active', outcome=NULL WHERE id=$1",[s.tenderA]);}
 });
 it('фильтры отделяют общие материалы, тендеры и конкретную карточку вместе со счётчиками',async()=>{
  expect((await s.manager.get('/history/summary?scope=common')).body.bindings).toHaveLength(2);
  expect((await s.manager.get('/history/summary?scope=tenders')).body.bindings).toHaveLength(1);
  expect((await s.manager.get('/history/summary?tenderId='+s.tenderA)).body.bindings).toHaveLength(1);
  expect((await s.manager.get('/history?scope=common&tenderId='+s.tenderA)).status).toBe(400);
  expect((await s.eng3.get('/history?q='+encodeURIComponent('Закрытые сведения'))).body.items).toEqual([]);
 });
 it('поиск и курсор работают в общей области',async()=>{
  const a=await s.eng3.get('/history/files?scope=common&limit=1');expect(a.body.nextCursor).toBeTruthy();
  const b=await s.eng3.get('/history/files?scope=common&limit=1&cursor='+a.body.nextCursor);expect(b.body.items[0].id).not.toBe(a.body.items[0].id);
  expect((await s.eng3.get('/history/files?scope=common&q='+encodeURIComponent('условия'))).body.items).toHaveLength(1);
  expect((await s.eng3.get('/history?scope=common&cursor=bad')).status).toBe(400);
 });
 it('общая задача назначается содержательному пользователю и не попадает в очередь тендера',async()=>{
  const file=(await s.eng3.get('/history/files?scope=common')).body.items[0];
  const created=await s.eng3.post('/history/tasks',{title:'Проверить общий шаблон',fileId:file.id,ownerUserId:s.ids.eng1},{headers:idem()});expect(created.status,created.text).toBe(201);expect(created.body.tender_id).toBe(null);
  expect((await s.manager.get('/history/tasks?tenderId='+s.tenderA)).body.items).toEqual([]);
  expect((await s.eng1.get('/history/tasks?scope=common')).body.items).toHaveLength(1);
  const closed=await s.eng1.patch('/history-tasks/'+created.body.id,{status:'resolved',ownerUserId:s.ids.eng1,dueAt:null,resolution:'Шаблон проверен'},{headers:{'If-Match':created.headers.etag}});expect(closed.status,closed.text).toBe(200);
 });
 it('не позволяет прикрепить закрытый файл тендера к общей задаче или общий — к тендерной',async()=>{
  const privateFile=(await s.eng1.get('/history/files?tenderId='+s.tenderA)).body.items[0],commonFile=(await s.eng1.get('/history/files?scope=common')).body.items[0];
  expect((await s.eng3.post('/history/tasks',{title:'Неверное основание',fileId:privateFile.id},{headers:idem()})).status).toBe(404);
  expect((await s.eng1.post('/tenders/'+s.tenderA+'/history-tasks',{title:'Неверное основание',fileId:commonFile.id},{headers:idem()})).status).toBe(404);
 });
 it('наблюдает пустой шаблон каталогов и фиксирует изменение структуры без файлов',async()=>{
  await run(templateId);let summary=(await s.eng3.get('/history/summary?scope=common')).body;expect(summary.watch.find((w:{bindingId:string})=>w.bindingId===templateId).directories).toBe(1);
  expect(JSON.stringify((await s.eng3.get('/history?scope=common')).body)).not.toContain('directory_baseline');
  expect(JSON.stringify((await s.eng3.get('/history?scope=common&technical=true')).body)).toContain('directory_baseline');
  mkdirSync(join(templates,'Новый раздел'));await run(templateId);expect(JSON.stringify((await s.eng3.get('/history?scope=common')).body)).toContain('directory_structure_changed');
  const tasks=(await s.eng1.get('/history/tasks?scope=common')).body.items;expect(tasks.some((t:{tender_id:string|null;title:string})=>t.tender_id===null&&t.title.includes('Проверить изменения:'))).toBe(true);
 });
 it('наблюдает новый общий файл, проверяет SHA и сохраняет повтор без дублей',async()=>{
  await run(commonId);writeFileSync(join(conditions,'новые условия.txt'),'new');await run(commonId);await run(commonId,'verify');
  const files=(await s.eng3.get('/history/files?scope=common')).body.items;expect(files.find((f:{path:string})=>f.path==='новые условия.txt').sha256).toBe(hash('new'));
  const count=(await db.pool.query('SELECT count(*)::int n FROM tender_history_import')).rows[0]!.n;await run(commonId);expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_import')).rows[0]!.n).toBe(count);
 });
 it('отказ общей папки сохраняет последний успешный реестр',async()=>{
  renameSync(conditions,conditions+'-offline');try{await run(commonId);}finally{renameSync(conditions+'-offline',conditions);}
  expect((await s.eng3.get('/history/files?scope=common')).body.items).toHaveLength(3);
  expect((await s.eng3.get('/history/summary?scope=common')).body.watch.find((w:{bindingId:string})=>w.bindingId===commonId).lastErrorCode).toBe('history_root_unavailable');
 });
 it('сравнение общего файла доступно инженеру вне тендера, но требует содержательной роли',async()=>{
  const record=(await db.pool.query("SELECT id FROM tender_history_record WHERE binding_id=$1 AND kind='file_added' AND source_path='новые условия.txt'",[commonId])).rows[0]!.id;
  const url='/history/records/'+record;
  const r=await s.eng3.get(url+'/comparison');expect(r.status,r.text).toBe(200);expect(r.body.tenderId).toBe(null);expect(r.body.before.state).toBe('absent');expect(r.body.changes).toMatchObject([{kind:'added',after:'new'}]);
  await db.pool.query("DELETE FROM user_role WHERE user_id=$1 AND role='manager'",[s.ids.admin]);
  try{expect((await s.admin.get(url+'/comparison')).status).toBe(404);expect((await s.admin.get(url+'/versions/after/original')).status).toBe(404);}
  finally{await db.pool.query("INSERT INTO user_role(user_id,role) VALUES($1,'manager')",[s.ids.admin]);}
 });
 it('управлять общим подключением может только администратор, с защитой версии',async()=>{
  const path='/history-watches/'+commonId,body={enabled:false},headers={'If-Match':'"'+commonId+':1"'};
  expect((await s.manager.put(path,body,{headers})).status).toBe(403);expect((await s.eng1.put(path,body,{headers})).status).toBe(403);
  expect((await s.admin.put(path,body,{headers})).status).toBe(200);expect((await s.admin.put(path,{enabled:true},{headers})).status).toBe(412);
 });
 it('назначение в общую область не создаёт тендеров и не изменяет идентичность источника',async()=>{
  expect((await db.pool.query('SELECT count(*)::int n FROM tender')).rows[0]!.n).toBe(2);
  await expect(db.pool.query('UPDATE tender_history_binding SET tender_id=$2 WHERE id=$1',[commonId,s.tenderA])).rejects.toThrow();
  const members=await s.eng3.get('/history/members');expect(members.status).toBe(200);expect(members.body.items.some((m:{userId:string})=>m.userId===s.ids.eng3)).toBe(true);
 });
});
