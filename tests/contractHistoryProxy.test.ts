import {afterAll,beforeAll,it,expect} from 'vitest';
import {createHmac,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {buildScenario,createTestDb,makeApp,testConfig,type ITestDb,type IScenario} from './helpers.ts';
import {grantCreator,createContract,setAccess} from './contractFixtures.ts';
import {importContractHistory,loadAccessContext,withTransaction} from '../packages/db/src/index.ts';
import {contractHistorySourceKey} from '../packages/storage/src/index.ts';
import {startContractHistoryProxy} from '../apps/worker/src/contractHistoryProxy.ts';
let db:ITestDb,s:IScenario,id:string,fileId:string,root:string,port:number,stop:()=>Promise<void>;
const key='ab'.repeat(32),name='Договор маи\u0306.pdf',path='Объект\\'+name,bytes=Buffer.from('%PDF-1.4\ncontract-history-proxy\n');
const signed=async(actor:string,signatureKey=key)=>{
 const nonce=Date.now()+'.'+randomBytes(16).toString('hex');
 const signature=createHmac('sha256',signatureKey).update(actor+'|'+id+'|'+fileId+'|'+nonce).digest('hex');
 return fetch('http://127.0.0.1:'+port+'/internal/contract-history/'+id+'/'+fileId,{headers:{'x-kontur-actor':actor,'x-kontur-nonce':nonce,'x-kontur-signature':signature}});
};
beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'kontur-contract-proxy-'));await mkdir(join(root,'Объект'));await writeFile(join(root,'Объект',name),bytes);
 const net=createServer();await new Promise<void>(r=>net.listen(0,'127.0.0.1',r));port=(net.address() as {port:number}).port;await new Promise<void>(r=>net.close(()=>r()));
 db=await createTestDb();const config={...testConfig(),contractHistoryRoot:root,contractHistoryProxyPort:port,contractHistoryProxyKey:key};
 s=await buildScenario(db,makeApp(db,undefined,config));await grantCreator(s.admin,s.ids.manager);id=await createContract(s.manager,'Proxy-test');
 const info=await stat(join(root,'Объект',name),{bigint:true}),ctx=(await loadAccessContext(db.pool,s.ids.manager,'proxy-test'))!;
 await withTransaction(db.pool,c=>importContractHistory(c,ctx,id,{sourceKey:contractHistorySourceKey(root),groupKey:'proxy',folderName:'Объект',folderPath:'Объект',mappingBasis:'Synthetic fixture',sourceSha256:'d'.repeat(64),startedAt:'2026-01-01T00:00:00Z',observedAt:'2026-01-01T00:01:00Z',complete:true,files:[{key:'main',path,name,role:'main',status:'linked',basis:'Synthetic main',mainKey:null,parentKey:null,documentDate:null,dateBasis:null,modifiedAt:null,size:bytes.length,mtimeNs:info.mtimeNs.toString(),signedHint:false,draftHint:false,locus:null,notes:''}]}));
 fileId=(await s.manager.get('/contracts/'+id+'/history')).body.items[0].id;
 stop=await startContractHistoryProxy(db.pool,config);
});
afterAll(async()=>{await stop?.();await db?.drop();if(root?.startsWith(join(tmpdir(),'kontur-contract-proxy-')))await rm(root,{recursive:true,force:true});});
it('preserves the actual Unicode path instead of normalizing the filename',async()=>{
 const row=(await db.pool.query('SELECT relative_path FROM contract_history_entry WHERE id=$1',[fileId])).rows[0];
 expect(row.relative_path).toBe(path);expect(path.normalize('NFC')).not.toBe(path);
});
it('serves the exact PDF through the authenticated public route and worker reader',async()=>{
 const r=await s.manager.get('/contracts/'+id+'/history/files/'+fileId+'/original');expect(r.status).toBe(200);expect(r.body).toEqual(bytes);expect(r.headers['content-type']).toContain('application/pdf');
 const internal=await signed(s.ids.manager);expect(internal.status).toBe(200);expect(internal.headers.get('x-kontur-response')).toMatch(/^[a-f0-9]{64}$/);expect(Buffer.from(await internal.arrayBuffer())).toEqual(bytes);
});
it('rejects unsigned requests and incorrect signatures',async()=>{
 expect((await fetch('http://127.0.0.1:'+port+'/internal/contract-history/'+id+'/'+fileId)).status).toBe(404);
 expect((await signed(s.ids.manager,'ff'.repeat(32))).status).toBe(404);
});
it('the worker checks actual contract access even for a correctly signed request',async()=>{
 expect((await signed(s.ids.eng1)).status).toBe(404);
 await setAccess(s.admin,id,s.ids.eng1,['contract.read']);const allowed=await signed(s.ids.eng1);expect(allowed.status).toBe(200);await allowed.arrayBuffer();
 await setAccess(s.admin,id,s.ids.eng1,[]);expect((await signed(s.ids.eng1)).status).toBe(404);
});
it('denies changed originals instead of serving bytes from a different observation',async()=>{
 await writeFile(join(root,'Объект',name),Buffer.concat([bytes,Buffer.from('changed')]));
 expect((await s.manager.get('/contracts/'+id+'/history/files/'+fileId+'/original')).status).toBe(409);
});
