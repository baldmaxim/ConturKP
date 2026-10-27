import {Worker} from 'node:worker_threads';
import {Router} from 'express';
import {z} from 'zod';
import {getHistoryVersionPair,type IHistoryVersionPair,type Pool} from '@kontur/db';
import {historyCanArchive,historyContentMediaType} from '@kontur/core';
import {readHistoryDocumentEditor,type IHistoryComparison} from '@kontur/adapters';
import type {BlobStore} from '@kontur/storage';
import {query,uuidParam,parseBody} from '../http/command.ts';
import {HttpError,notFound} from '../http/errors.ts';

const editorCache=new Map<string,Promise<string|null>>();
const documentEditor=async(store:BlobStore,pair:IHistoryVersionPair)=>{
 const version=pair.after;if(version.state!=='file'||!version.available||!version.sha256)return null;
 const key=version.sha256;let value=editorCache.get(key);
 if(!value){if(editorCache.size>=500)editorCache.delete(editorCache.keys().next().value!);value=readHistoryDocumentEditor(pair.path,store.pathOf(key));editorCache.set(key,value);}
 const name=await value;if(!name){editorCache.delete(key);return null;}
 return {name,source:'document-properties' as const};
};
let active=0;
const compare=(store:BlobStore,pair:IHistoryVersionPair):Promise<IHistoryComparison&{byteIdentical:boolean}>=>{
 if(active>=2)throw new HttpError(429,'RATE_LIMITED','Сравнение занято. Повторите попытку через несколько секунд.');
 const input=(side:IHistoryVersionPair['before'])=>side.state==='file'?{path:store.pathOf(side.sha256!),sha256:side.sha256,size:side.size}:null;
 const worker=new Worker(new URL('../historyComparisonWorker.ts',import.meta.url),{workerData:{name:pair.path,before:input(pair.before),after:input(pair.after)},resourceLimits:{maxOldGenerationSizeMb:384}});
 active++;
 let timer:ReturnType<typeof setTimeout>;
 return new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new HttpError(422,'VALIDATION_FAILED','Сравнение слишком объёмное. Используйте сохранённые оригиналы.')),30_000);
  worker.once('message',resolve);worker.once('error',()=>reject(new HttpError(422,'VALIDATION_FAILED','Не удалось выполнить сравнение сохранённых версий.')));
  worker.once('exit',()=>reject(new HttpError(422,'VALIDATION_FAILED','Сравнение остановлено. Используйте сохранённые оригиналы.')));
 }).finally(()=>{clearTimeout(timer);active--;void worker.terminate();}) as Promise<IHistoryComparison&{byteIdentical:boolean}>;
};

export const historyContentRouter=(pool:Pool,store:BlobStore):Router=>{
 const router=Router();
 router.get('/history/records/:id/versions',query(pool,'history.content.metadata','tender_history_record',async(ctx,req,res)=>{
  const q=parseBody(z.object({currentOnly:z.enum(['true','false']).default('false')}),req.query);
  const pair=await getHistoryVersionPair(pool,ctx,uuidParam(req,'id','tender_history_record'),q.currentOnly==='true');if(!pair)throw notFound();
  res.json({...pair,editor:await documentEditor(store,pair)});
 }));
 router.get('/history/records/:id/comparison',query(pool,'history.content.compare','tender_history_record',async(ctx,req,res)=>{
  const pair=await getHistoryVersionPair(pool,ctx,uuidParam(req,'id','tender_history_record'));if(!pair)throw notFound();
  if(!historyCanArchive(pair.path,0)){res.json({...pair,status:'unsupported',format:'unsupported',changes:[],warnings:['Сравнение этого формата пока недоступно. Поддерживаются DOCX, XLSX, PDF, текстовые файлы и изображения. Почтовые файлы доступны через отдельные почтовые права.'],stats:{added:0,removed:0,changed:0},truncated:false,byteIdentical:false});return;}
  for(const side of [pair.before,pair.after])if(side.state==='file'&&side.available&&!(await store.exists(side.sha256!)))side.available=false;
  if(!pair.before.available||!pair.after.available){res.json({...pair,status:'missing_versions',format:'unsupported',changes:[],warnings:['Для сравнения нужны обе сохранённые версии. Недостающие копии прежних событий восстановить по дате и размеру нельзя.'],stats:{added:0,removed:0,changed:0},truncated:false,byteIdentical:false});return;}
  const result=await compare(store,pair);res.json({...pair,...result});
 }));
 router.get('/history/records/:id/versions/:side/original',query(pool,'history.content.original','tender_history_record',async(ctx,req,res)=>{
  if(req.params.side!=='before'&&req.params.side!=='after')throw notFound();
  const pair=await getHistoryVersionPair(pool,ctx,uuidParam(req,'id','tender_history_record'));if(!pair)throw notFound();
  const side=pair[req.params.side];if(side.state!=='file'||!side.available||!side.sha256)throw notFound();
  try{if(!(await store.verify(side.sha256)))throw Error('unavailable');}catch{throw new HttpError(409,'STATE_CONFLICT','Сохранённая версия недоступна или не прошла проверку целостности.');}
  res.setHeader('Content-Type',historyContentMediaType(pair.path));res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Length',side.size!);
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent((req.params.side==='before'?'До — ':'После — ')+(pair.path.split(/[\\/]/).at(-1)??'Файл')));
  const stream=store.openRead(side.sha256);res.once('close',()=>stream.destroy());stream.once('error',()=>res.destroy());stream.pipe(res);
 }));
 return router;
};
