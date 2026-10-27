import { apiGet,apiPatch,apiPost,apiPut,etagOf,API_BASE } from './client';
import { xhrUpload } from './upload';
export type HistoryScope='all'|'common'|'tenders';
export type HistoryTenderFilter=string|string[]|null;
export interface IHistoryBinding {id:string;tenderId:string|null;tenderCode:string;canManage:boolean;externalFolderId:string;folderName:string;observedAt:string|null;observationStartedAt:string|null;complete:boolean|null;files:number;importedAt:string|null}
export interface IHistorySync {bindingId:string;enabled:boolean;rowVersion:number;lastCheckedAt:string|null;lastSuccessAt:string|null;lastErrorCode:string|null}
export interface IHistoryWatch {bindingId:string;enabled:boolean;rowVersion:number;lastCheckedAt:string|null;lastSuccessAt:string|null;lastErrorCode:string|null;lastFullHashAt:string|null;intervalSeconds:number;unverified:number;directories:number}
export interface IHistoryChangedProject {tenderId:string|null;tenderCode:string;title:string;changes:number;lastChangedAt:string}
export interface IHistorySummary {bindings:IHistoryBinding[];tasks:{open:number;overdue:number};sync:IHistorySync[];watch:IHistoryWatch[];related:{tenderId:string;tenderCode:string;reason:string}[];changedProjects:IHistoryChangedProject[];canWriteCommon:boolean;canManage:boolean}
export interface IHistoryFileFacts {size:number;modifiedAt:string|null;sha256:string|null}
export interface IHistoryImportReceipt {id:string;uploadName:string|null;sourceKind:'upload'|'watched_folder';status:'running'|'completed'|'completed_with_errors'|'failed';expanded:boolean;total:number;registered:number;duplicate:number;pending:number;rejected:number;skipped:number;preview:string[]}
export interface IHistoryEntry {id:string;tenderId:string|null;tenderCode:string;recordId:string|null;stageId:string|null;kind:string;title:string;detail:string;occurredAt:string|null;importedAt:string;revision:number;sourcePath:string|null;sourceLabel:string;origin:'historical'|'portal'|'observation';folderName:string;importBatch?:IHistoryImportReceipt|null;actorName?:string|null;actorKind?:'human'|'system'|null;fileChange?:{before:IHistoryFileFacts|null;after:IHistoryFileFacts}|null}
export interface IHistoryFile {id:string;tenderId:string|null;tenderCode:string;path:string;size:number;sha256:string|null;modifiedAt:string|null;verifiedAt:string|null;status:string;technical:boolean;folderName:string;observedAt:string;complete:boolean}
export interface IHistoryTask {id:string;tender_id:string|null;tender_code:string;title:string;status:'open'|'in_progress'|'resolved';owner_user_id:string|null;owner_name:string|null;due_at:string|null;resolution:string|null;row_version:number;record_id:string|null;file_id:string|null}
export interface IHistoryPage<T> {items:T[];nextCursor:string|null}
export interface IHistoryTaskInput {title:string;recordId?:string|null;fileId?:string|null;ownerUserId?:string|null;dueAt?:string|null}
export interface IHistoryContentVersion {fileId:string|null;state:'file'|'absent'|'unknown';available:boolean;sha256:string|null;size:number|null;modifiedAt:string|null;capturedAt:string|null}
export interface IHistoryContentComparison {recordId:string;path:string;before:IHistoryContentVersion;after:IHistoryContentVersion;status:'ready'|'partial'|'unsupported'|'unreadable'|'missing_versions';format:'text'|'cells'|'image'|'pdf'|'unsupported';changes:{kind:'added'|'removed'|'changed';location:string;before:string|null;after:string|null}[];stats:{added:number;removed:number;changed:number};warnings:string[];truncated:boolean;byteIdentical:boolean}
export interface IHistoryVersionPair {recordId:string;path:string;tenderId:string|null;editor?:{name:string;source:'document-properties'}|null;before:IHistoryContentVersion;after:IHistoryContentVersion}
export const getHistoryVersions=(recordId:string,signal?:AbortSignal,currentOnly=false)=>apiGet<IHistoryVersionPair>('/history/records/'+encodeURIComponent(recordId)+'/versions'+(currentOnly?'?currentOnly=true':''),{signal});
export const getHistoryContentComparison=(recordId:string,signal?:AbortSignal)=>apiGet<IHistoryContentComparison>('/history/records/'+encodeURIComponent(recordId)+'/comparison',{signal});
export const historyVersionUrl=(recordId:string,side:'before'|'after')=>API_BASE+'/history/records/'+encodeURIComponent(recordId)+'/versions/'+side+'/original';
const queryScope=(id:HistoryTenderFilter,scope:HistoryScope)=>{const p=new URLSearchParams({scope});for(const value of id===null?[]:Array.isArray(id)?id:[id])p.append('tenderId',value);return p;};
export const getHistorySummary=(id:HistoryTenderFilter,signal?:AbortSignal,scope:HistoryScope='all')=>apiGet<IHistorySummary>('/history/summary?'+queryScope(id,scope),{signal});
export const getHistory=(id:HistoryTenderFilter,part:'history'|'history-files',q:string,technical:boolean,cursor:string|null,signal?:AbortSignal,scope:HistoryScope='all')=>{
  const params=queryScope(id,scope);params.set('q',q);params.set('technical',String(technical));params.set('limit','40');if(part==='history')params.set('fileFacts','false');if(cursor)params.set('cursor',cursor);
  return apiGet<IHistoryPage<IHistoryEntry|IHistoryFile>>('/history'+(part==='history-files'?'/files':'')+'?'+params,{signal});
};
export const getHistoryTasks=(id:HistoryTenderFilter,signal?:AbortSignal,scope:HistoryScope='all')=>apiGet<{items:IHistoryTask[]}>('/history/tasks?'+queryScope(id,scope),{signal});
export const listSharedHistoryMembers=(signal?:AbortSignal)=>apiGet<{items:{userId:string;displayName:string}[]}>('/history/members',{signal});
export const getHistoryReportSources=(id:string,signal?:AbortSignal)=>apiGet<{items:{key:string;label:string}[]}>('/tenders/'+encodeURIComponent(id)+'/history-report-sources',{signal});
export const configureHistorySync=(id:string,bindingId:string,rowVersion:number,sourceKey:string,enabled:boolean)=>
  apiPut('/tenders/'+encodeURIComponent(id)+'/history-sync',{ifMatch:etagOf(bindingId,rowVersion),body:{bindingId,sourceKey,enabled}});
export const configureHistoryWatch=(id:string|null,watch:IHistoryWatch,enabled:boolean)=>apiPut(id?'/tenders/'+encodeURIComponent(id)+'/history-watch':'/history-watches/'+watch.bindingId,{ifMatch:etagOf(watch.bindingId,watch.rowVersion),body:id?{bindingId:watch.bindingId,enabled}:{enabled}});
export const createHistoryTask=(id:string|null,body:IHistoryTaskInput)=>apiPost<IHistoryTask>(id?'/tenders/'+encodeURIComponent(id)+'/history-tasks':'/history/tasks',{body,idempotencyKey:crypto.randomUUID()});
export const updateHistoryTask=(task:IHistoryTask,body:{status:IHistoryTask['status'];ownerUserId:string|null;dueAt:string|null;resolution:string|null})=>
  apiPatch<IHistoryTask>('/history-tasks/'+task.id,{body,ifMatch:etagOf(task.id,task.row_version)});
export const uploadHistory=(id:string,file:File,folderId:string,onProgress:(fraction:number)=>void)=>
  xhrUpload<{repeated:boolean;recordsAdded:number;filesAdded:number}>(API_BASE+'/tenders/'+encodeURIComponent(id)+'/history-import?'+new URLSearchParams({name:file.name,folderId,confirmBinding:'true'}),file,crypto.randomUUID(),onProgress);
