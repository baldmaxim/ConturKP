import {parentPort,workerData} from 'node:worker_threads';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compareHistoryBuffers} from '@kontur/adapters';
import {HISTORY_CONTENT_MAX_BYTES} from '@kontur/core';
interface IInput {path:string;sha256:string;size:number}
const load=async(input:IInput|null):Promise<Buffer|null>=>{
 if(!input)return null;if(input.size>HISTORY_CONTENT_MAX_BYTES)throw Error('too_large');
 if((await stat(input.path)).size!==input.size)throw Error('content_unavailable');
 const bytes=await readFile(input.path);if(bytes.length!==input.size||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('content_unavailable');return bytes;
};
try{
 const data=workerData as {name:string;before:IInput|null;after:IInput|null};
 const before=await load(data.before),after=data.after?.sha256===data.before?.sha256&&data.before?before:await load(data.after);
 const result=await compareHistoryBuffers(data.name,before,after);
 parentPort!.postMessage({...result,byteIdentical:!!data.before&&!!data.after&&data.before.sha256===data.after.sha256});
}catch(error){parentPort!.postMessage({status:'unreadable',format:'unsupported',changes:[],warnings:[error instanceof Error&&error.message==='too_large'?'Версия больше 64 МиБ: используйте сохранённые оригиналы.':'Сохранённая копия недоступна или не прошла проверку целостности.'],stats:{added:0,removed:0,changed:0},truncated:false,byteIdentical:false});}
