import {createHmac,timingSafeEqual} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {pipeline} from 'node:stream/promises';
import type {IAppConfig} from '@kontur/config';
import {getContractHistoryFile,loadAccessContext,type Pool} from '@kontur/db';
import {contractHistorySourceKey,openContractHistoryFile} from '@kontur/storage';

const mac=(key:string,text:string)=>createHmac('sha256',key).update(text).digest('hex');
const equal=(a:string,b:string)=>/^[a-f0-9]{64}$/u.test(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

// A signed, loopback-only reader under the existing worker identity. No arbitrary paths or new grants.
export async function startContractHistoryProxy(pool:Pool,config:IAppConfig):Promise<()=>Promise<void>>{
 const port=config.contractHistoryProxyPort,key=config.contractHistoryProxyKey,root=config.contractHistoryRoot;
 if(!port||!key||!root)return async()=>{};
 const active=new Set<ServerResponse>();
 const server=createServer(async(req,res)=>{
  const reply=(status:number,reason:string)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({reason}));}else res.destroy();};
  try{
   const match=new RegExp('^/internal/contract-history/('+uuid+')/('+uuid+')$','u').exec(req.url??'');
   const actor=req.headers['x-kontur-actor'],nonce=req.headers['x-kontur-nonce'],signature=req.headers['x-kontur-signature'];
   if(req.method!=='GET'||!match||typeof actor!=='string'||!new RegExp('^'+uuid+'$','u').test(actor)||typeof nonce!=='string'||!/^\d{13}\.[a-f0-9]{32}$/u.test(nonce)||Math.abs(Date.now()-Number(nonce.split('.')[0]))>30000||typeof signature!=='string'||!equal(signature,mac(key,actor+'|'+match[1]+'|'+match[2]+'|'+nonce))){reply(404,'history_unavailable');return;}
   if(active.size>=4){reply(503,'history_busy');return;}
   active.add(res);res.once('close',()=>active.delete(res));
   const ctx=await loadAccessContext(pool,actor,'contract-history-proxy');
   const f=ctx?await getContractHistoryFile(pool,ctx,match[1]!,match[2]!):null;
   if(!f){reply(404,'history_unavailable');return;}
   if(contractHistorySourceKey(root)!==f.source){reply(409,'history_source_unavailable');return;}
   const file=await openContractHistoryFile(root,f.path,{size:f.size,mtime:f.mtime});
   res.once('close',()=>file.stream.destroy());
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,'Cache-Control':'no-store','X-Kontur-Response':mac(key,'response|'+nonce+'|'+file.size)});
   await pipeline(file.stream,res);
  }catch(e){const message=e instanceof Error?e.message:'';reply(message==='history_file_too_large'?413:409,message==='history_source_changed'?'history_source_changed':'history_source_unavailable');}
 });
 server.keepAliveTimeout=1000;server.maxConnections=8;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 server.on('error',()=>{for(const res of active)res.destroy();});
 return async()=>{for(const res of active)res.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));};
}
