import { contractCaps, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export interface IContractHistoryEntryInput {
  key: string; path: string; name: string; role: 'main' | 'addendum' | 'appendix' | 'act' | 'other';
  status: 'linked' | 'needs_review' | 'unassigned'; basis: string;
  mainKey: string | null; parentKey: string | null; documentDate: string | null; dateBasis: string | null;
  modifiedAt: string | null; size: number; mtimeNs: string; signedHint: boolean; draftHint: boolean;
  locus: Record<string, unknown> | null; notes: string;
}
export interface IContractHistoryInput {
  sourceKey: string; groupKey: string; folderName: string; folderPath: string; mappingBasis: string;
  sourceSha256: string; observedAt: string; startedAt: string; complete: boolean; files: IContractHistoryEntryInput[];
}

export const contractHistoryPath = (value: string): string => {
  const p = value.replaceAll('/', '\\');
  if (!p || p.length > 4000 || /[:\u0000-\u001f]/u.test(p) || p.startsWith('\\') ||
      p.split('\\').some((s) => !s || s === '.' || s === '..')) throw new Error('history_invalid_path');
  return p;
};

export const importContractHistory = async (db: Queryable, ctx: IAccessContext, contractId: string, input: IContractHistoryInput) => {
  const caps = contractCaps(ctx, contractId);
  if (!caps.includes('contract.read') || !caps.includes('contract.manage')) throw new Error('history_access_denied');
  if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256) || input.files.length > 20000 ||
      !Number.isFinite(Date.parse(input.observedAt)) || !Number.isFinite(Date.parse(input.startedAt)) ||
      Date.parse(input.startedAt) > Date.parse(input.observedAt)) throw new Error('history_invalid_import');
  contractHistoryPath(input.folderPath);
  const keys = new Set<string>(), paths = new Set<string>();
  for (const f of input.files) {
    const path = contractHistoryPath(f.path).normalize('NFC').toLowerCase();
    if (paths.has(path) || keys.has(f.key) || !f.key || !f.name || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('history_invalid_file');
    paths.add(path); keys.add(f.key);
  }
  const files = new Map(input.files.map((f) => [f.key, f]));
  for (const f of input.files) {
    const main = f.mainKey ? files.get(f.mainKey) : null;
    const parent = f.parentKey ? files.get(f.parentKey) : null;
    if (f.mainKey && (!main || main.role !== 'main' || main.key === f.key)) throw new Error('history_invalid_family');
    if (f.parentKey && (!parent || !['main','addendum'].includes(parent.role) || parent.key === f.key ||
        (parent.key !== f.mainKey && parent.mainKey !== f.mainKey))) throw new Error('history_invalid_family');
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['contract-history:' + contractId]);
  const binding = (await db.query<{id:string}>(
    'SELECT id FROM contract_history_binding WHERE contract_id=$1 AND source_key=$2 AND group_key=$3',
    [contractId,input.sourceKey,input.groupKey])).rows[0]?.id ??
    (await db.query<{id:string}>(
      'INSERT INTO contract_history_binding(contract_id,source_key,group_key,folder_name,folder_path,mapping_basis,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [contractId,input.sourceKey,input.groupKey,input.folderName,input.folderPath,input.mappingBasis,ctx.principal.userId])).rows[0]!.id;
  const old = (await db.query<{id:string}>('SELECT id FROM contract_history_import WHERE binding_id=$1 AND source_sha256=$2',[binding,input.sourceSha256])).rows[0];
  if (old) return { bindingId:binding, importId:old.id, repeated:true, filesAdded:0 };
  const id = (await db.query<{id:string}>(
    'INSERT INTO contract_history_import(binding_id,source_sha256,observed_at,started_at,complete,imported_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [binding,input.sourceSha256,input.observedAt,input.startedAt,input.complete,ctx.principal.userId])).rows[0]!.id;
  for (const f of input.files) await db.query(
    'INSERT INTO contract_history_entry(import_id,external_key,relative_path,file_name,role,relation_status,relation_basis,main_key,parent_key,document_date,date_basis,modified_at,size_bytes,mtime_ns,signed_hint,draft_hint,locus,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)',
    [id,f.key,contractHistoryPath(f.path),f.name,f.role,f.status,f.basis,f.mainKey,f.parentKey,f.documentDate,f.dateBasis,f.modifiedAt,f.size,f.mtimeNs,f.signedHint,f.draftHint,f.locus?JSON.stringify(f.locus):null,f.notes]);
  return {bindingId:binding,importId:id,repeated:false,filesAdded:input.files.length};
};

const LATEST = 'WITH latest AS (SELECT DISTINCT ON (binding_id) id,binding_id,observed_at FROM contract_history_import ORDER BY binding_id,observed_at DESC,created_at DESC,id DESC) ';
export const contractHistorySummary = async (db: Queryable, ctx: IAccessContext, contractId: string) => {
  if (!contractCaps(ctx,contractId).includes('contract.read')) return null;
  const folders = (await db.query(
    'SELECT b.id,b.folder_name AS name,b.mapping_basis AS basis,i.observed_at AS "observedAt",i.complete,'+
    '(SELECT count(*)::int FROM contract_history_entry e WHERE e.import_id=i.id) AS files '+
    'FROM contract_history_binding b LEFT JOIN LATERAL (SELECT * FROM contract_history_import WHERE binding_id=b.id ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1)i ON true WHERE b.contract_id=$1 ORDER BY b.created_at,b.id',[contractId])).rows;
  const counts = (await db.query(LATEST+
    "SELECT count(*)::int AS files,count(*) FILTER(WHERE e.relation_status<>'linked')::int AS review,"+
    "count(*) FILTER(WHERE e.role='main')::int AS mains,count(*) FILTER(WHERE e.role='addendum')::int AS addenda,"+
    "count(*) FILTER(WHERE e.role='appendix')::int AS appendices "+
    'FROM contract_history_entry e JOIN latest l ON l.id=e.import_id JOIN contract_history_binding b ON b.id=l.binding_id WHERE b.contract_id=$1',[contractId])).rows[0];
  const observations = (await db.query(
    'SELECT i.id,b.folder_name AS folder,i.observed_at AS "observedAt",i.created_at AS "importedAt",i.complete,'+
    '(SELECT count(*)::int FROM contract_history_entry e WHERE e.import_id=i.id) AS files '+
    'FROM contract_history_import i JOIN contract_history_binding b ON b.id=i.binding_id WHERE b.contract_id=$1 ORDER BY i.observed_at DESC,i.id DESC LIMIT 30',[contractId])).rows;
  return {folders,counts,observations};
};

export const listContractHistory = async (db: Queryable, ctx: IAccessContext, contractId: string,
  query: {q:string;role:string;review:boolean;offset:number;limit:number}) => {
  if (!contractCaps(ctx,contractId).includes('contract.read')) return null;
  const params = [contractId,query.q,query.role,query.review,query.limit,query.offset];
  const where = " WHERE b.contract_id=$1 AND ($2='' OR position(lower($2) in lower(e.relative_path))>0)"+
    " AND ($3='' OR e.role=$3) AND (NOT $4 OR e.relation_status<>'linked')";
  const from = ' FROM contract_history_entry e JOIN latest l ON l.id=e.import_id JOIN contract_history_binding b ON b.id=l.binding_id';
  const total=(await db.query(LATEST+'SELECT count(*)::int AS n'+from+where,params.slice(0,4))).rows[0].n as number;
  const items=(await db.query(LATEST+
    'SELECT e.id,e.file_name AS name,e.relative_path AS path,e.role,e.relation_status AS status,e.relation_basis AS basis,'+
    'e.document_date::text AS "documentDate",e.date_basis AS "dateBasis",e.modified_at AS "modifiedAt",e.size_bytes::text AS "sizeBytes",'+
    'e.signed_hint AS "signedHint",e.draft_hint AS "draftHint",e.locus,e.notes,m.file_name AS "mainName",p.file_name AS "parentName",'+
    'm.id AS "mainId",p.id AS "parentId",l.observed_at AS "observedAt",b.folder_name AS folder'+from+
    ' LEFT JOIN contract_history_entry m ON m.import_id=e.import_id AND m.external_key=e.main_key'+
    ' LEFT JOIN contract_history_entry p ON p.import_id=e.import_id AND p.external_key=e.parent_key'+where+
    " ORDER BY CASE e.role WHEN 'main' THEN 0 ELSE 1 END,e.document_date DESC NULLS LAST,e.file_name,e.id LIMIT $5 OFFSET $6",params)).rows;
  return {items,total,nextOffset:query.offset+items.length<total?query.offset+items.length:null};
};

export const getContractHistoryFile = async (db: Queryable,ctx:IAccessContext,contractId:string,fileId:string) => {
  if (!contractCaps(ctx,contractId).includes('contract.read')) return null;
  return (await db.query<{name:string;path:string;size:string;mtime:string;source:string}>(
    'SELECT e.file_name AS name,e.relative_path AS path,e.size_bytes::text AS size,e.mtime_ns AS mtime,b.source_key AS source '+
    'FROM contract_history_entry e JOIN contract_history_import i ON i.id=e.import_id JOIN contract_history_binding b ON b.id=i.binding_id WHERE e.id=$1 AND b.contract_id=$2',[fileId,contractId])).rows[0]??null;
};
