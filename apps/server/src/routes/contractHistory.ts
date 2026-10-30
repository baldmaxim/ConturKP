import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import type {ReadableStream} from 'node:stream/web';
import type { IAppConfig } from '@kontur/config';
import { contractHistorySummary,getContractHistoryFile,listContractHistory,type Pool } from '@kontur/db';
import { contractHistorySourceKey,openContractHistoryFile } from '@kontur/storage';
import { Router } from 'express';
import { query,uuidParam } from '../http/command.ts';
import { HttpError,notFound } from '../http/errors.ts';

const viaWorker=async(config:IAppConfig,actor:string,contract:string,file:string,expectedSize:string)=>{
 const nonce=Date.now()+'.'+randomBytes(16).toString('hex'),key=config.contractHistoryProxyKey!;
 const signature=createHmac('sha256',key).update(actor+'|'+contract+'|'+file+'|'+nonce).digest('hex');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{
  const r=await fetch('http://127.0.0.1:'+config.contractHistoryProxyPort+'/internal/contract-history/'+contract+'/'+file,{headers:{'x-kontur-actor':actor,'x-kontur-nonce':nonce,'x-kontur-signature':signature},signal:controller.signal});
  if(!r.ok){const error=await r.json() as {reason?:string};throw Error(['history_source_changed','history_file_too_large'].includes(error.reason??'')?error.reason!:'history_source_unavailable');}
  const size=r.headers.get('content-length')??'',response=r.headers.get('x-kontur-response')??'';
  const proof=createHmac('sha256',key).update('response|'+nonce+'|'+size).digest('hex');
  if(size!==expectedSize||!r.body||!/^[a-f0-9]{64}$/u.test(response)||!timingSafeEqual(Buffer.from(response,'hex'),Buffer.from(proof,'hex'))){await r.body?.cancel();throw Error('history_source_unavailable');}
  return {stream:Readable.fromWeb(r.body as ReadableStream),size};
 }finally{clearTimeout(timer);}
};
export const contractHistoryRouter=(pool:Pool,config:IAppConfig):Router=>{
  const router=Router();
  router.get('/contracts/:id/history',query(pool,'contract.history.read','contract',async(ctx,req,res)=>{
    const id=uuidParam(req,'id','contract');
    const summary=await contractHistorySummary(pool,ctx,id);
    if(!summary)throw notFound({entityType:'contract',entityId:id});
    const rawOffset=String(req.query.offset??'0');
    if(!/^\d{1,8}$/u.test(rawOffset))throw new HttpError(400,'VALIDATION_FAILED','Некорректная страница');
    const role=typeof req.query.role==='string'?req.query.role:'';
    if(!['','main','addendum','appendix','act','other'].includes(role))throw new HttpError(400,'VALIDATION_FAILED','Некорректный вид документа');
    const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,500):'';
    const files=await listContractHistory(pool,ctx,id,{q,role,review:req.query.review==='true',offset:Number(rawOffset),limit:50});
    res.json({...summary,...files,originalsAvailable:Boolean(config.contractHistoryRoot)});
  }));
  router.get('/contracts/:id/history/files/:fileId/original',query(pool,'contract.history.original','contract',async(ctx,req,res)=>{
    const id=uuidParam(req,'id','contract'),fileId=uuidParam(req,'fileId','contract_history_entry');
    const file=await getContractHistoryFile(pool,ctx,id,fileId);
    if(!file)throw notFound({entityType:'contract',entityId:id});
    if(!config.contractHistoryRoot||contractHistorySourceKey(config.contractHistoryRoot)!==file.source)
      throw new HttpError(409,'STATE_CONFLICT','Источник архива сейчас не подключён');
    try{
      const opened=config.contractHistoryProxyPort ? await viaWorker(config,ctx.principal.userId,id,fileId,file.size) : await openContractHistoryFile(config.contractHistoryRoot,file.path,{size:file.size,mtime:file.mtime});
      res.once('close',()=>opened.stream.destroy());
      res.setHeader('Content-Type',file.name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/octet-stream');
      res.setHeader('Content-Length',opened.size);
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('Content-Disposition',"inline; filename*=UTF-8''"+encodeURIComponent(file.name));
      res.on('close',()=>opened.stream.destroy());
      opened.stream.on('error',()=>res.destroy());opened.stream.pipe(res);
    }catch(error){
      const code=error instanceof Error?error.message:'';
      if(code==='history_source_changed')throw new HttpError(409,'STATE_CONFLICT','Файл изменился после снимка. Обновите историю перед открытием.');
      if(code==='history_file_too_large')throw new HttpError(413,'VALIDATION_FAILED','Файл превышает предел просмотра архива');
      throw new HttpError(409,'STATE_CONFLICT','Исходный файл недоступен. Проверьте подключение архива.');
    }
  }));
  return router;
};
