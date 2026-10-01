// Видимость производного текста этапа 08 (Р-08-5, OD-08-4, R08-02): формулировка требования, факта, кандидата и
// результат прогона показываются целиком, только если пользователь может читать все их основания (любой роли,
// с наследованием — requirementTaint.ts) по правам источника — те же правила, что у цитаты (getScopedFragment): фрагмент тендера — доступ к тендеру,
// договора — contract.read, письма и вложения — mail.read на ящик, транскрипции и Q&A — доступ к тендеру.
// Право на реестр само по себе ничего из источника не открывает; отзыв и возврат права действуют сразу.
import { contentTenderIds, readableContractIds, readableMailboxIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

// Из переданных фрагментов — те, что пользователь может читать сейчас.
export const readableFragments = async (db: Queryable, ctx: IAccessContext, ids: readonly string[]): Promise<Set<string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const r = await db.query<{ id: string }>(
    `SELECT f.id
       FROM evidence_fragment f
       LEFT JOIN document_revision dr ON dr.id = f.document_revision_id
       LEFT JOIN document d ON d.id = dr.document_id
       LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
       LEFT JOIN mail_message_revision amr ON amr.id = a.revision_id
       LEFT JOIN mail_message am ON am.id = amr.message_id
       LEFT JOIN mail_message_revision mr ON mr.id = f.mail_message_revision_id
       LEFT JOIN mail_message m ON m.id = mr.message_id
      WHERE f.id = ANY($1::uuid[])
        AND (f.tender_id = ANY($2::uuid[]) OR f.contract_id = ANY($3::uuid[])
             OR coalesce(m.mailbox_id, am.mailbox_id) = ANY($4::uuid[]))`,
    [unique, contentTenderIds(ctx), readableContractIds(ctx), readableMailboxIds(ctx)],
  );
  return new Set(r.rows.map((x) => x.id));
};

export interface IEvidenceLinkRow {
  owner_id: string;
  fragment_id: string;
  role: string;
  origin: string;
  text: string;
  source_unit_type: string;
  page_index: number | null;
}

export type EvidenceOwnerColumn =
  | 'requirement_candidate_id'
  | 'requirement_revision_id'
  | 'fact_candidate_id'
  | 'fact_revision_id'
  | 'decision_id'
  | 'assumption_revision_id';

// Основания владельцев одного вида — одним запросом.
export const linksOf = async (db: Queryable, column: EvidenceOwnerColumn, ownerIds: readonly string[]): Promise<Map<string, IEvidenceLinkRow[]>> => {
  const out = new Map<string, IEvidenceLinkRow[]>();
  if (ownerIds.length === 0) return out;
  const r = await db.query<IEvidenceLinkRow>(
    `SELECT l.${column} AS owner_id, l.fragment_id, l.role, f.origin, f.text, f.source_unit_type, f.page_index
       FROM evidence_link l JOIN evidence_fragment f ON f.id = l.fragment_id
      WHERE l.${column} = ANY($1::uuid[])
      ORDER BY l.role, f.page_index NULLS LAST, f.ordinal NULLS LAST, l.fragment_id`,
    [ownerIds],
  );
  for (const row of r.rows) {
    const list = out.get(row.owner_id) ?? [];
    list.push(row);
    out.set(row.owner_id, list);
  }
  return out;
};

// Основания владельца пишутся в транзакции его создания (охранник evidence_link).
export const insertEvidenceLinks = async (
  db: Queryable,
  column: EvidenceOwnerColumn,
  ownerId: string,
  tenderId: string,
  userId: string,
  refs: readonly { fragmentId: string; role: string }[],
): Promise<void> => {
  if (refs.length === 0) return;
  await db.query(
    `INSERT INTO evidence_link (tender_id, fragment_id, role, ${column}, created_by)
     SELECT $1, u.f, u.r, $2, $3 FROM unnest($4::uuid[], $5::text[]) AS u(f, r)`,
    [tenderId, ownerId, userId, refs.map((e) => e.fragmentId), refs.map((e) => e.role)],
  );
};

// Копия оснований одного владельца другому (подтверждение кандидата, замена ревизии).
export const copyEvidenceLinks = async (
  db: Queryable,
  from: { column: EvidenceOwnerColumn; id: string },
  to: { column: EvidenceOwnerColumn; id: string },
  tenderId: string,
  userId: string,
): Promise<void> => {
  await db.query(
    `INSERT INTO evidence_link (tender_id, fragment_id, role, ${to.column}, created_by)
     SELECT $1, fragment_id, role, $2, $3 FROM evidence_link WHERE ${from.column} = $4`,
    [tenderId, to.id, userId, from.id],
  );
};

// Какие из фрагментов входят в снимок (перенос кандидата в новый реестр).
export const fragmentsInScope = async (db: Queryable, scopeId: string, ids: readonly string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const r = await db.query<{ id: string }>('SELECT u.id FROM unnest($2::uuid[]) AS u(id) WHERE evidence_scope_has_fragment($1, u.id)', [scopeId, [...ids]]);
  return new Set(r.rows.map((x) => x.id));
};
