import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,utimesSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {enqueueJob} from '../packages/db/src/jobs.ts';
import {buildZip} from './ooxmlFixtures.ts';
import {buildScenario,createTestDb,drain,idem,makeApp,makeWorker,testConfig,type IScenario,type ITestDb} from './helpers.ts';
const base=mkdtempSync(join(tmpdir(),'history-content-')),root=join(base,'tender');mkdirSync(root);
const path=join(root,'условия.txt'),hash=(s:string)=>createHash('sha256').update(s).digest('hex');writeFileSync(path,'Цена: 100');
const config=testConfig({historyWatchRoots:[root]});let db:ITestDb,s:IScenario,bindingId:string,eventId:string,metadataId:string;
const run=async(mode:'scan'|'verify')=>{await enqueueJob(db.pool,{kind:'history.'+mode,payload:{bindingId},dedupeKey:randomUUID(),tenderId:s.tenderA,resourceClass:'network'});await drain(makeWorker(db,config));};
const endpoint=(id=eventId)=>'/history/records/'+id;
const latest=async(kind:string)=>(await db.pool.query('SELECT id FROM tender_history_record WHERE kind=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[kind])).rows[0]!.id;
beforeAll(async()=>{
 db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,config));
 const report=JSON.stringify({folders:[{id:'330. Пример',tender_id:'content',tender:true}],snapshot:{started_at:'2026-10-23T10:00:00Z',finished_at:'2026-10-23T10:35:00Z',complete:true},events:[],files:[{p:'330. Пример/условия.txt',tender_id:'content',s:Buffer.byteLength('Цена: 100'),h:hash('Цена: 100'),m:statSync(path).mtime.toISOString(),end:new Date().toISOString(),st:'ok'}]});
 const r=await s.manager.post('/tenders/'+s.tenderA+'/history-import?name=history.json&folderId=content&confirmBinding=true',Buffer.from(report),{headers:{...idem(),'Content-Type':'application/octet-stream'}});expect(r.status,r.text).toBe(200);bindingId=r.body.bindingId;
 await db.pool.query('INSERT INTO tender_history_watch(binding_id,root_path,configured_by,stability_seconds) VALUES($1,$2,$3,0)',[bindingId,root,s.ids.manager]);await run('scan');await run('verify');
});
afterAll(async()=>{await db?.drop();});
describe('версии из событий хронологии',()=>{
 it('сохраняет исходную копию до первого изменения',async()=>{expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_content')).rows[0]!.n).toBeGreaterThan(0);});
 it('до проверки новой версии честно сообщает о недостающей копии',async()=>{
  writeFileSync(path,'Цена: 200');utimesSync(path,new Date(),new Date(Date.now()+2000));await run('scan');metadataId=await latest('file_modified');
  const r=await s.eng1.get(endpoint(metadataId)+'/comparison');expect(r.status,r.text).toBe(200);expect(r.body.status).toBe('missing_versions');expect(r.body.before.available).toBe(true);expect(r.body.after.available).toBe(false);
 });
 it('показывает точные до/после из события свойств и события содержимого',async()=>{
  await run('verify');eventId=await latest('file_content_changed');
  const metadata=await s.eng1.get(endpoint(metadataId)+'/versions');expect(metadata.status,metadata.text).toBe(200);expect(metadata.body.before.sha256).toBe(hash('Цена: 100'));expect(metadata.body.after.sha256).toBe(hash('Цена: 200'));expect(metadata.body.changes).toBeUndefined();
  for(const id of [metadataId,eventId]){const r=await s.eng1.get(endpoint(id)+'/comparison');expect(r.status,r.text).toBe(200);expect(r.body.status).toBe('ready');expect(r.body.changes).toMatchObject([{before:'Цена: 100',after:'Цена: 200'}]);}
 });
 it('для краткого окна читает текущую версию без прежнего снимка',async()=>{
  const brief=await s.eng1.get(endpoint(metadataId)+'/versions?currentOnly=true');expect(brief.status,brief.text).toBe(200);expect(brief.body.before.state).toBe('unknown');expect(brief.body.after.sha256).toBe(hash('Цена: 200'));
  expect((await s.eng1.get(endpoint(metadataId)+'/versions?currentOnly=invalid')).status).toBe(400);
 });
 it('скачивает сохранённые версии и не подменяет их последующим содержимым сетевого файла',async()=>{
  writeFileSync(path,'Цена: 9999');utimesSync(path,new Date(),new Date(Date.now()+5000));await run('scan');await run('verify');
  const r=await s.manager.get(endpoint()+'/comparison');expect(r.body.changes).toMatchObject([{before:'Цена: 100',after:'Цена: 200'}]);
  for(const [side,text] of [['before','Цена: 100'],['after','Цена: 200']]){const original=await s.eng1.get(endpoint()+'/versions/'+side+'/original');expect(original.status).toBe(200);expect(Buffer.from(original.body).toString()).toBe(text);expect(original.headers['cache-control']).toContain('no-store');}
 });
 it('закрывает обе точки неназначенному инженеру и чистому администратору',async()=>{
  for(const client of [s.eng3,s.admin])for(const suffix of ['/versions','/comparison','/versions/before/original','/versions/after/original'])expect((await client.get(endpoint()+suffix)).status).toBe(404);
 });
 it('фиксирует отсутствие отдельно и сравнение доступно после исчезновения файла',async()=>{
  unlinkSync(path);await run('scan');await run('scan');const missing=await latest('file_missing');
  const r=await s.manager.get(endpoint(missing)+'/comparison');expect(r.body.after.state).toBe('absent');expect(r.body.changes).toMatchObject([{kind:'removed',before:'Цена: 9999',after:null}]);
  expect((await s.manager.get(endpoint()+'/comparison')).body.changes).toMatchObject([{after:'Цена: 200'}]);
 });
 it('запрещает переписывать копии и привязывать файл другого пути',async()=>{
  await expect(db.pool.query('UPDATE tender_history_content SET captured_at=now()')).rejects.toThrow();
  writeFileSync(join(root,'другой.txt'),'Другое');await run('scan');await run('verify');const other=await latest('file_added');
  const foreign=(await db.pool.query("SELECT id FROM tender_history_file WHERE relative_path='условия.txt' LIMIT 1")).rows[0]!.id;
  await expect(db.pool.query('INSERT INTO tender_history_record_versions(record_id,before_file_id) VALUES($1,$2)',[other,foreign])).rejects.toThrow();
 });
 it('не выдаёт содержимое писем в обход почтовых прав',async()=>{
  writeFileSync(join(root,'письмо.eml'),'Private mail');await run('scan');await run('verify');const mail=await latest('file_added');
  const r=await s.manager.get(endpoint(mail)+'/comparison');expect(r.body.status).toBe('unsupported');expect(r.body.after.available).toBe(false);expect((await s.manager.get(endpoint(mail)+'/versions/after/original')).status).toBe(404);
 });
 it('не считает неизвестную старую версию пустым файлом',async()=>{
  const pending=join(root,'без копии.txt');writeFileSync(pending,'Пропущенная версия');await run('scan');
  writeFileSync(pending,'Новая версия');utimesSync(pending,new Date(),new Date(Date.now()+9000));await run('scan');const id=await latest('file_modified');await run('verify');
  const r=await s.manager.get(endpoint(id)+'/comparison');expect(r.status).toBe(200);expect(r.body.status).toBe('missing_versions');expect(r.body.before.state).toBe('file');expect(r.body.before.available).toBe(false);expect(r.body.after.available).toBe(true);expect(r.body.changes).toEqual([]);
 });
 it('показывает редактора из свойств документа, защищает кеш правами и не назначает автора исчезновения',async()=>{
  const doc=join(root,'редактор.docx');writeFileSync(doc,buildZip([{name:'docProps/core.xml',data:'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Создатель</dc:creator><cp:lastModifiedBy>Иван Петров</cp:lastModifiedBy></cp:coreProperties>'}]));await run('scan');await run('verify');
  const id=(await db.pool.query("SELECT id FROM tender_history_record WHERE source_path='редактор.docx' AND kind='file_added' ORDER BY created_at DESC LIMIT 1")).rows[0]!.id;
  const metadata=await s.eng1.get(endpoint(id)+'/versions');expect(metadata.status,metadata.text).toBe(200);expect(metadata.body.editor).toEqual({name:'Иван Петров',source:'document-properties'});
  for(const client of [s.eng3,s.admin])expect((await client.get(endpoint(id)+'/versions')).status).toBe(404);
  unlinkSync(doc);await run('scan');await run('scan');const missing=(await db.pool.query("SELECT id FROM tender_history_record WHERE source_path='редактор.docx' AND kind='file_missing' ORDER BY created_at DESC LIMIT 1")).rows[0]!.id;
  const absent=await s.eng1.get(endpoint(missing)+'/versions');expect(absent.status,absent.text).toBe(200);expect(absent.body.editor).toBe(null);
 });

});
