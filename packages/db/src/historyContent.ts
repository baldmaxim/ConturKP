import {HISTORY_CONTENT_MAX_BYTES,historyCanArchive} from '@kontur/core';
import {contentTenderIds,type IAccessContext} from './access.ts';
import {canReadSharedHistory} from './tenderHistory.ts';
import type {Queryable} from './pool.ts';

export interface IHistoryVersion {fileId:string|null;state:'file'|'absent'|'unknown';available:boolean;sha256:string|null;size:number|null;modifiedAt:Date|null;capturedAt:Date|null}
export interface IHistoryVersionPair {recordId:string;path:string;tenderId:string|null;before:IHistoryVersion;after:IHistoryVersion}
const absent=():IHistoryVersion=>({fileId:null,state:'absent',available:true,sha256:null,size:null,modifiedAt:null,capturedAt:null});
const unknown=():IHistoryVersion=>({...absent(),state:'unknown',available:false});
const side=async(db:Queryable,fileId:string|null,missing:boolean):Promise<IHistoryVersion>=>{
 if(missing)return absent();if(!fileId)return unknown();
 const row=(await db.query(`SELECT f.id,f.size_bytes AS size,f.modified_at,c.captured_at,
  coalesce(c.blob_sha256,f.sha256) AS sha256,b.sha256 IS NOT NULL AS available
  FROM tender_history_file f LEFT JOIN tender_history_content c ON c.file_id=f.id
  LEFT JOIN blob b ON b.sha256=coalesce(c.blob_sha256,f.sha256) AND b.size_bytes=f.size_bytes WHERE f.id=$1`,[fileId])).rows[0];
 if(!row)return unknown();return {fileId,state:'file',available:row.available,sha256:row.sha256,size:row.size,modifiedAt:row.modified_at,capturedAt:row.captured_at};
};
export const getHistoryVersionPair=async(db:Queryable,ctx:IAccessContext,recordId:string,currentOnly=false):Promise<IHistoryVersionPair|null>=>{
 const row=(await db.query(`SELECT r.id,r.kind,r.source_path,b.tender_id,r.binding_id,r.import_id,i.created_at,
  v.record_id AS linked,v.before_file_id,v.after_file_id,v.before_absent,v.after_absent
  FROM tender_history_record r JOIN tender_history_binding b ON b.id=r.binding_id JOIN tender_history_import i ON i.id=r.import_id
  LEFT JOIN tender_history_record_versions v ON v.record_id=r.id WHERE r.id=$1 AND NOT r.restricted AND r.source_path IS NOT NULL
  AND r.kind IN('file_added','file_modified','file_missing','file_restored','file_content_changed')
  AND(b.tender_id=ANY($2::uuid[]) OR($3 AND b.tender_id IS NULL))`,[recordId,contentTenderIds(ctx),canReadSharedHistory(ctx)])).rows[0];
 if(!row)return null;
 let beforeId=row.before_file_id??null,afterId=row.after_file_id??null,beforeAbsent=row.before_absent??['file_added','file_restored'].includes(row.kind),afterAbsent=row.after_absent??row.kind==='file_missing';
 if(!row.linked){
  if(!afterAbsent)afterId=(await db.query(`SELECT id FROM tender_history_file WHERE import_id=$1 AND path_key=lower(normalize(replace($2,chr(92),'/'),NFC))`,[row.import_id,row.source_path])).rows[0]?.id??null;
  if(!currentOnly&&!beforeAbsent)beforeId=(await db.query(`SELECT f.id FROM tender_history_file f JOIN tender_history_import i ON i.id=f.import_id
   WHERE f.binding_id=$1 AND f.path_key=lower(normalize(replace($2,chr(92),'/'),NFC)) AND i.created_at<$3
   ORDER BY i.created_at DESC,f.id DESC LIMIT 1`,[row.binding_id,row.source_path,row.created_at])).rows[0]?.id??null;
 }
 const before=currentOnly?(beforeAbsent?absent():unknown()):await side(db,beforeId,beforeAbsent),after=await side(db,afterId,afterAbsent);
 // Mail/archive/unknown formats cannot obtain original bytes through a history-content endpoint.
 for(const version of [before,after])if(version.state==='file'&&!historyCanArchive(row.source_path,0))version.available=false;
 return {recordId,path:row.source_path,tenderId:row.tender_id,before,after};
};

export const historyContentPendingPredicate=`lower(o.relative_path) ~ '\\.(docx|xlsx|pdf|txt|csv|md|json|xml|yaml|yml|svg|png|jpg|jpeg|gif|webp|bmp|tif|tiff|doc|xls)$'
 AND o.size_bytes<=${HISTORY_CONTENT_MAX_BYTES} AND EXISTS(SELECT 1 FROM tender_history_file f WHERE f.id=o.file_id AND NOT f.technical)
 AND NOT EXISTS(SELECT 1 FROM tender_history_content c WHERE c.file_id=o.file_id)`;
