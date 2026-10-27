import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDb,makeApp,buildScenario,testConfig,type ITestDb,type IScenario} from './helpers.ts';
import {createContract,grantCreator,setAccess} from './contractFixtures.ts';
import {importContractHistory,loadAccessContext,withTransaction,type IContractHistoryInput} from '../packages/db/src/index.ts';
let db:ITestDb,s:IScenario,id:string;
const input:IContractHistoryInput={
 sourceKey:'source-test',groupKey:'group-test',folderName:'Объект',folderPath:'Объект',mappingBasis:'Заголовок договора',
 sourceSha256:'a'.repeat(64),startedAt:'2026-10-23T09:00:00Z',observedAt:'2026-10-23T09:01:00Z',complete:true,
 files:[
  {key:'main',path:'Объект\\Договор.pdf',name:'Договор.pdf',role:'main',status:'linked',basis:'Основной документ',mainKey:null,parentKey:null,documentDate:'2025-01-01',dateBasis:'document_header',modifiedAt:'2026-01-01T00:00:00Z',size:10,mtimeNs:'1',signedHint:false,draftHint:false,locus:null,notes:''},
  {key:'ds',path:'Объект\\ДС 1\\ДС №1.pdf',name:'ДС №1.pdf',role:'addendum',status:'linked',basis:'Семья договора',mainKey:'main',parentKey:'main',documentDate:'2026-01-01',dateBasis:'filename',modifiedAt:null,size:20,mtimeNs:'2',signedHint:true,draftHint:false,locus:null,notes:''},
  {key:'app',path:'Объект\\ДС 1\\Приложение.pdf',name:'Приложение.pdf',role:'appendix',status:'linked',basis:'Пакет ДС 1',mainKey:'main',parentKey:'ds',documentDate:null,dateBasis:null,modifiedAt:null,size:30,mtimeNs:'3',signedHint:false,draftHint:false,locus:null,notes:''},
  {key:'unclear',path:'Объект\\Другой договор.pdf',name:'Другой договор.pdf',role:'other',status:'needs_review',basis:'Принадлежность не подтверждена',mainKey:null,parentKey:null,documentDate:null,dateBasis:null,modifiedAt:null,size:30,mtimeNs:'4',signedHint:false,draftHint:false,locus:null,notes:''}
 ]};
const importData=async(value=input)=>{
 const ctx=(await loadAccessContext(db.pool,s.ids.manager,'test-history'))!;
 return withTransaction(db.pool,client=>importContractHistory(client,ctx,id,value));
};
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db,undefined,testConfig()));await grantCreator(s.admin,s.ids.manager);id=await createContract(s.manager,'История-1');});
afterAll(async()=>{await db.drop();});
it('imports a family and shows chronology only with contract.read',async()=>{
 expect((await importData()).filesAdded).toBe(4);
 const r=await s.manager.get('/contracts/'+id+'/history');expect(r.status).toBe(200);
 expect(r.body.counts).toMatchObject({files:4,mains:1,addenda:1,appendices:1,review:1});
 expect(r.body.items.find((x:any)=>x.name==='Приложение.pdf')).toMatchObject({mainName:'Договор.pdf',parentName:'ДС №1.pdf'});
 expect((await s.eng1.get('/contracts/'+id+'/history')).status).toBe(404);
 expect((await s.admin.get('/contracts/'+id+'/history')).status).toBe(404);
});
it('repeated import is idempotent and filters preserve the family',async()=>{
 expect(await importData()).toMatchObject({repeated:true,filesAdded:0});
 const r=await s.manager.get('/contracts/'+id+'/history?role=appendix&q='+encodeURIComponent('ДС 1'));
 expect(r.body.total).toBe(1);expect(r.body.items[0].parentName).toBe('ДС №1.pdf');
 const review=await s.manager.get('/contracts/'+id+'/history?review=true');expect(review.body.total).toBe(1);
});
it('rejects traversal, duplicate paths and cross-family references before insertion',async()=>{
 for(const bad of [
  {...input,files:[{...input.files[0]!,path:'..\\secret'}]},
  {...input,files:[input.files[0]!,{...input.files[1]!,path:'ОБЪЕКТ\\ДОГОВОР.PDF'}]},
  {...input,files:[{...input.files[1]!,mainKey:'outside'}]}
 ])await expect(importData({...bad,sourceSha256:'b'.repeat(64)})).rejects.toThrow();
});
it('a new snapshot preserves old entries and selects the newest observation',async()=>{
 await importData({...input,sourceSha256:'c'.repeat(64),observedAt:'2026-10-24T09:01:00Z',files:input.files.slice(0,3)});
 expect((await db.pool.query('SELECT count(*)::int AS n FROM contract_history_entry')).rows[0].n).toBe(7);
 const r=await s.manager.get('/contracts/'+id+'/history');expect(r.body.total).toBe(3);expect(r.body.observations).toHaveLength(2);
});
it('revoking access hides history and direct original links',async()=>{
 await setAccess(s.admin,id,s.ids.eng1,['contract.read']);
 const r=await s.eng1.get('/contracts/'+id+'/history');expect(r.status).toBe(200);const file=r.body.items[0].id;
 await setAccess(s.admin,id,s.ids.eng1,[]);
 expect((await s.eng1.get('/contracts/'+id+'/history')).status).toBe(404);
 expect((await s.eng1.get('/contracts/'+id+'/history/files/'+file+'/original')).status).toBe(404);
});
it('history is immutable and missing parents are rejected by the database',async()=>{
 await expect(db.pool.query("UPDATE contract_history_entry SET notes='changed'")).rejects.toThrow();
 const latest=(await db.pool.query('SELECT id FROM contract_history_import ORDER BY observed_at DESC LIMIT 1')).rows[0].id;
 await expect(withTransaction(db.pool,async client=>{
  await client.query("INSERT INTO contract_history_entry(import_id,external_key,relative_path,file_name,role,relation_status,relation_basis,main_key,size_bytes,mtime_ns) VALUES($1,'wrong','wrong.pdf','wrong.pdf','appendix','linked','test','missing',1,'1')",[latest]);
 })).rejects.toThrow();
});
