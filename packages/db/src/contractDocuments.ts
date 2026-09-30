// Документы договора (T06A-2, D-023): общая модель document/document_revision с contract_id.
// Роли — основной договор, допсоглашение, приложение; допсоглашение и приложение — самостоятельные
// документы со ссылкой на основной документ договора. Новая версия файла — новая редакция того же
// документа; прежняя редакция не меняется и остаётся в исторических снимках (T06A-1).
// Загрузки одного договора сериализуются блокировкой строки договора; одно содержимое в договоре —
// одна редакция (UNIQUE (contract_id, blob_sha256)). Этапы тендеров загрузка не затрагивает (D-017).
import { nameKeyOf } from '@kontur/core';
import { readableContractIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export type ContractRole = 'contract' | 'addendum' | 'appendix';

export interface IContractDocumentRow {
  id: string;
  contract_id: string;
  title: string;
  contract_role: ContractRole;
  main_document_id: string | null;
  recognition_route: 'auto' | 'local' | 'rdweb';
  row_version: number;
  created_at: Date;
  updated_at: Date;
  revisions: number;
  latest_revision_id: string;
  latest_revision_seq: number;
  latest_received_at: Date;
  latest_media_type: string;
  latest_size_bytes: number;
  latest_run_status: string | null;
}

const SELECT_DOCUMENT = `
  SELECT d.id, d.contract_id, d.title, d.contract_role, d.main_document_id, d.recognition_route, d.row_version, d.created_at, d.updated_at,
         (SELECT count(*)::int FROM document_revision x WHERE x.document_id = d.id) AS revisions,
         lr.id AS latest_revision_id, lr.revision_seq AS latest_revision_seq, lr.received_at AS latest_received_at,
         b.media_type AS latest_media_type, b.size_bytes AS latest_size_bytes,
         (SELECT r.status FROM recognition_run r WHERE r.document_revision_id = lr.id ORDER BY r.created_at DESC, r.id LIMIT 1) AS latest_run_status
    FROM document d
    JOIN LATERAL (SELECT x.* FROM document_revision x WHERE x.document_id = d.id ORDER BY x.revision_seq DESC LIMIT 1) lr ON true
    JOIN blob b ON b.sha256 = lr.blob_sha256`;

// Порядок: основной договор, затем допсоглашения и приложения в порядке загрузки.
export const listContractDocuments = async (db: Queryable, contractId: string): Promise<IContractDocumentRow[]> => {
  const r = await db.query<IContractDocumentRow>(
    `${SELECT_DOCUMENT} WHERE d.contract_id = $1
      ORDER BY CASE d.contract_role WHEN 'contract' THEN 0 WHEN 'addendum' THEN 1 ELSE 2 END, d.created_at, d.id`,
    [contractId],
  );
  return r.rows;
};

// Документ договора виден только с contract.read (D-022 OD-2); иначе null — маршрут отвечает 404.
export const getContractDocument = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IContractDocumentRow | null> => {
  const r = await db.query<IContractDocumentRow>(`${SELECT_DOCUMENT} WHERE d.id = $1 AND d.contract_id = ANY($2::uuid[])`, [id, readableContractIds(ctx)]);
  return r.rows[0] ?? null;
};

export const updateContractDocumentTitle = async (db: Queryable, id: string, title: string): Promise<void> => {
  await db.query('UPDATE document SET title = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [id, title]);
};

export type ContractUploadTarget =
  | { kind: 'document'; role: ContractRole; mainDocumentId: string | null; title: string }
  | { kind: 'revision'; documentId: string };

export type ContractRegistration =
  | { status: 'registered'; documentId: string; revisionId: string; newDocument: boolean; revisionSeq: number }
  | { status: 'duplicate'; documentId: string; revisionId: string; revisionSeq: number }
  // То же содержимое уже есть в договоре другим документом: вторую редакцию того же файла БД не примет.
  | { status: 'content_in_other_document'; documentId: string; revisionId: string }
  | { status: 'main_document_exists'; documentId: string }
  | { status: 'main_document_missing' }
  | { status: 'document_not_found' };

// Вызывающий держит блокировку строки договора (getContract lock = true): проверка «такое
// содержимое уже есть» не разъезжается со вставкой редакции при одновременной загрузке.
export const registerContractFile = async (
  db: Queryable,
  ctx: IAccessContext,
  f: { contractId: string; target: ContractUploadTarget; blobSha256: string; observedName: string },
): Promise<ContractRegistration> => {
  const existing = await db.query<{ id: string; document_id: string; revision_seq: number }>(
    'SELECT id, document_id, revision_seq FROM document_revision WHERE contract_id = $1 AND blob_sha256 = $2',
    [f.contractId, f.blobSha256],
  );
  const same = existing.rows[0];
  if (same) {
    if (f.target.kind === 'revision' && same.document_id !== f.target.documentId) {
      return { status: 'content_in_other_document', documentId: same.document_id, revisionId: same.id };
    }
    return { status: 'duplicate', documentId: same.document_id, revisionId: same.id, revisionSeq: same.revision_seq };
  }
  let documentId: string;
  let newDocument = false;
  if (f.target.kind === 'revision') {
    const d = await db.query<{ id: string }>('SELECT id FROM document WHERE id = $1 AND contract_id = $2', [f.target.documentId, f.contractId]);
    if (!d.rows[0]) return { status: 'document_not_found' };
    documentId = d.rows[0].id;
  } else {
    const main = await db.query<{ id: string }>("SELECT id FROM document WHERE contract_id = $1 AND contract_role = 'contract'", [f.contractId]);
    if (f.target.role === 'contract' && main.rows[0]) return { status: 'main_document_exists', documentId: main.rows[0].id };
    if (f.target.role !== 'contract' && (!main.rows[0] || main.rows[0].id !== f.target.mainDocumentId)) return { status: 'main_document_missing' };
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (contract_id, contract_role, main_document_id, title, name_key, doc_type)
       VALUES ($1, $2, $3, $4, $5, 'contract') RETURNING id`,
      [f.contractId, f.target.role, f.target.role === 'contract' ? null : f.target.mainDocumentId, f.target.title.slice(0, 500), nameKeyOf(f.observedName)],
    );
    documentId = d.rows[0]!.id;
    newDocument = true;
  }
  const prev = await db.query<{ id: string; revision_seq: number }>(
    'SELECT id, revision_seq FROM document_revision WHERE document_id = $1 ORDER BY revision_seq DESC LIMIT 1',
    [documentId],
  );
  const seq = (prev.rows[0]?.revision_seq ?? 0) + 1;
  const rev = await db.query<{ id: string }>(
    `INSERT INTO document_revision (document_id, contract_id, blob_sha256, revision_seq, supersedes_revision_id, registered_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [documentId, f.contractId, f.blobSha256, seq, prev.rows[0]?.id ?? null, ctx.principal.userId],
  );
  return { status: 'registered', documentId, revisionId: rev.rows[0]!.id, newDocument, revisionSeq: seq };
};

// ---------------------------------------------------------------- Кандидаты в состав этапа (D-017)

export interface IContractCandidateRow {
  contract_id: string;
  contract_number: string;
  contract_title: string;
  document_id: string;
  document_title: string;
  contract_role: ContractRole;
  document_revision_id: string;
  revision_seq: number;
  run_status: string | null;
}

// Последние редакции документов договоров, действующе связанных с тендером и читаемых пользователем.
// Связь область не расширяет: это лишь предложение; ищутся единицы после явного включения в состав.
export const contractCandidates = async (db: Queryable, ctx: IAccessContext, tenderId: string): Promise<IContractCandidateRow[]> => {
  const r = await db.query<IContractCandidateRow>(
    `SELECT c.id AS contract_id, c.number AS contract_number, c.title AS contract_title, d.id AS document_id, d.title AS document_title,
            d.contract_role, lr.id AS document_revision_id, lr.revision_seq,
            (SELECT r.status FROM recognition_run r WHERE r.document_revision_id = lr.id ORDER BY r.created_at DESC, r.id LIMIT 1) AS run_status
       FROM contract_tender l
       JOIN contract c ON c.id = l.contract_id
       JOIN document d ON d.contract_id = c.id
       JOIN LATERAL (SELECT x.id, x.revision_seq FROM document_revision x WHERE x.document_id = d.id ORDER BY x.revision_seq DESC LIMIT 1) lr ON true
      WHERE l.tender_id = $1 AND l.status = 'active' AND c.id = ANY($2::uuid[])
      ORDER BY c.number, CASE d.contract_role WHEN 'contract' THEN 0 WHEN 'addendum' THEN 1 ELSE 2 END, d.created_at, d.id`,
    [tenderId, readableContractIds(ctx)],
  );
  return r.rows;
};

// Владельцы редакций: для проверки состава этапа (тендер или связанный договор).
export const revisionOwners = async (
  db: Queryable,
  revisionIds: string[],
): Promise<Map<string, { tenderId: string | null; contractId: string | null }>> => {
  const r = await db.query<{ id: string; tender_id: string | null; contract_id: string | null }>(
    'SELECT id, tender_id, contract_id FROM document_revision WHERE id = ANY($1::uuid[])',
    [revisionIds],
  );
  return new Map(r.rows.map((x) => [x.id, { tenderId: x.tender_id, contractId: x.contract_id }]));
};
