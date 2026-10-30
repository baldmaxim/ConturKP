import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createBatch,insertBlob,insertItem,registerItem} from '../packages/db/src/sources.ts';
import {emitStageEvents} from '../packages/db/src/stageEvents.ts';
import {buildScenario,createTestDb,makeApp,type IScenario,type ITestDb} from './helpers.ts';
let db:ITestDb,s:IScenario,batchA:string,batchB:string,waiting:string;
const names=['01/Условия.docx','02/Смета.xlsx','03/Пояснения.pdf','04/Пропущен.docx','05/Поздний.txt'];
const receipt=async(client:Parameters<typeof createBatch>[0],tenderId:string,stageId:string,batchId:string)=>emitStageEvents(client,{tenderId,stageIds:[stageId],eventType:'import_accepted',refType:'import_batch',refId:batchId,actorUserId:s.ids.manager});
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db));const client=await db.pool.connect();try{await client.query('BEGIN');
 batchA=await createBatch(client,{tenderId:s.tenderA,stageId:s.stageA,sourceKind:'upload',channelId:null,uploadName:'Комплект заказчика.zip',uploadSha:null,createdBy:s.ids.manager});
 await insertBlob(client,{sha256:'e'.repeat(64),sizeBytes:1,mediaType:'application/pdf',storageKey:'test-receipt'});
 for(const [index,name] of names.entries()){
  const item=await insertItem(client,{batchId:batchA,tenderId:s.tenderA,memberPath:name,observedName:name.split('/').at(-1)!,status:index===2?'rejected':index===3?'skipped_partial':'pending',rejectReason:index===2?'corrupt':null,blobSha:index<2?'e'.repeat(64):null});
  if(index<2){const row=(await client.query('SELECT * FROM import_item WHERE id=$1',[item.id])).rows[0];await registerItem(client,row,{sourceKind:'upload',locator:name,channelId:null,actorUserId:s.ids.manager});}
 }
 await receipt(client,s.tenderA,s.stageA,batchA);
 waiting=await createBatch(client,{tenderId:s.tenderA,stageId:s.stageA,sourceKind:'upload',channelId:null,uploadName:'Новый архив.zip',uploadSha:null,createdBy:s.ids.manager});await receipt(client,s.tenderA,s.stageA,waiting);
 batchB=await createBatch(client,{tenderId:s.tenderB,stageId:s.stageB,sourceKind:'upload',channelId:null,uploadName:'Закрытый комплект B.zip',uploadSha:null,createdBy:s.ids.manager});
 await insertItem(client,{batchId:batchB,tenderId:s.tenderB,memberPath:'Закрытые объёмы B.xlsx',observedName:'Закрытые объёмы B.xlsx',status:'pending'});await receipt(client,s.tenderB,s.stageB,batchB);
 // Полиморфная ссылка намеренно указывает в другой тендер: сводка и поиск обязаны её отвергнуть.
 await receipt(client,s.tenderA,s.stageA,batchB);await receipt(client,s.tenderA,s.stageA,randomUUID());
 await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
afterAll(async()=>{await db?.drop();});
describe('понятное поступление документов в хронологии',()=>{
 it('показывает состав и результат обработки, краткий список ограничен тремя путями',async()=>{
  const page=await s.eng1.get('/history?fileFacts=false&limit=100');expect(page.status,page.text).toBe(200);
  const row=page.body.items.find((e:{importBatch?:{id:string}})=>e.importBatch?.id===batchA);
  expect(row).toMatchObject({title:'Поступило 5 файлов',tenderId:s.tenderA,stageId:s.stageA,importBatch:{id:batchA,uploadName:'Комплект заказчика.zip',sourceKind:'upload',total:5,registered:1,duplicate:1,pending:1,rejected:1,skipped:1,preview:names.slice(0,3)}});
  expect(row).not.toHaveProperty('batchId');
  const full=await s.eng1.get('/imports/'+batchA);expect(full.status,full.text).toBe(200);expect(full.body.items.map((i:{memberPath:string})=>i.memberPath)).toEqual(names);
  expect(full.body.items.map((i:{status:string})=>i.status)).toEqual(['registered','duplicate','rejected','skipped_partial','pending']);
 });
 it('находит имя за пределами краткого списка до применения пагинации',async()=>{
  for(const text of ['Поздний.txt','Комплект заказчика.zip']){
   const r=await s.eng1.get('/history?limit=1&q='+encodeURIComponent(text));expect(r.status,r.text).toBe(200);expect(r.body.items).toHaveLength(1);expect(r.body.items[0].importBatch.id).toBe(batchA);expect(r.body.nextCursor).toBe(null);
  }
 });
 it('пока состав не разобран, показывает имя загрузки и не сообщает о нуле принятых файлов',async()=>{
  const r=await s.eng1.get('/history?q='+encodeURIComponent('Новый архив.zip'));expect(r.status,r.text).toBe(200);expect(r.body.items).toHaveLength(1);
  expect(r.body.items[0]).toMatchObject({title:'Поступила загрузка: Новый архив.zip',importBatch:{id:waiting,total:0,expanded:false,status:'running',preview:[]}});
 });
 it('не подставляет состав чужого тендера даже по ошибочной ссылке события',async()=>{
  const page=await s.eng1.get('/history?limit=100');expect(JSON.stringify(page.body)).not.toMatch(/Закрытый комплект|Закрытые объёмы/);
  const foreign=await s.eng1.get('/history?q='+encodeURIComponent('Закрытые объёмы'));expect(foreign.body.items).toEqual([]);
  expect((await s.eng1.get('/imports/'+batchB)).status).toBe(404);
  const global=await s.manager.get('/history?limit=100');const right=global.body.items.find((e:{tenderId:string})=>e.tenderId===s.tenderB);expect(right).toMatchObject({title:'Поступил 1 файл',importBatch:{id:batchB,total:1}});
  expect(global.body.items.filter((e:{tenderId:string;importBatch?:{id:string}})=>e.tenderId===s.tenderA&&e.importBatch?.id===batchB)).toEqual([]);
  const selected=await s.manager.get('/history?tenderId='+s.tenderA+'&q='+encodeURIComponent('Закрытые объёмы'));expect(selected.body.items).toEqual([]);
 });
});
