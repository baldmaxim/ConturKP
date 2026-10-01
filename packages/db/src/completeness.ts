// Полнота реестра (OD-08-7, Р-08-7): единица — фрагмент снимка допустимого происхождения; состояние по
// фрагменту — covered / reviewed / explicitly_not_requirement / unreviewed (функция registry_fragment_states).
// Пакетная отметка по странице, редакции, ревизии письма, вопросу или транскрипции разворачивается в
// конкретные ID фрагментов, которые и хранятся. Завершение прохода — запись с пересчитанными БД счётчиками;
// при unreviewed > 0 её нет (инвариант 10). Молчание модели полноты не доказывает.
import { REVIEWABLE_ORIGINS, type FragmentReviewState, type MarkSelectorKind } from '@kontur/core';
import type { Queryable } from './pool.ts';

export interface ICompletenessCounts {
  total_units: number;
  reviewed_units: number;
  covered_units: number;
  explicit_not_requirement_units: number;
  unreviewed_units: number;
  empty_units: number;
}

export const registryCompleteness = async (db: Queryable, registryId: string): Promise<ICompletenessCounts> =>
  (await db.query<ICompletenessCounts>('SELECT * FROM registry_completeness($1)', [registryId])).rows[0]!;

export interface IUnitCompleteness {
  scope_item_id: string;
  unit_type: string;
  // Технический статус единицы без допустимых фрагментов (Р-08-7): прогона нет или фрагментов нет.
  technical_status: 'ok' | 'not_recognized' | 'no_fragments';
  total: number;
  covered: number;
  reviewed: number;
  explicit_not_requirement: number;
  unreviewed: number;
}

export const unitCompleteness = async (db: Queryable, registryId: string): Promise<IUnitCompleteness[]> =>
  (
    await db.query<IUnitCompleteness>(
      `SELECT i.id AS scope_item_id, i.unit_type,
              CASE WHEN i.unit_type = 'document_recognition' AND i.recognition_run_id IS NULL THEN 'not_recognized'
                   WHEN count(s.fragment_id) = 0 THEN 'no_fragments' ELSE 'ok' END AS technical_status,
              count(s.fragment_id)::int AS total,
              count(*) FILTER (WHERE s.state = 'covered')::int AS covered,
              count(*) FILTER (WHERE s.state = 'reviewed')::int AS reviewed,
              count(*) FILTER (WHERE s.state = 'explicitly_not_requirement')::int AS explicit_not_requirement,
              count(*) FILTER (WHERE s.state = 'unreviewed')::int AS unreviewed
         FROM requirement_registry g
         JOIN evidence_scope_item i ON i.scope_id = g.evidence_scope_id
         LEFT JOIN registry_fragment_states($1) s ON s.scope_item_id = i.id
        WHERE g.id = $1
        GROUP BY i.id, i.unit_type, i.recognition_run_id
        ORDER BY i.unit_type, i.id`,
      [registryId],
    )
  ).rows;

export interface IFragmentStateRow {
  fragment_id: string;
  scope_item_id: string;
  state: FragmentReviewState;
  origin: string;
  text: string;
  page_index: number | null;
  ordinal: number | null;
}

export const fragmentStates = async (
  db: Queryable,
  registryId: string,
  f: { scopeItemId: string | null; state: FragmentReviewState | null; limit: number; offset: number },
): Promise<IFragmentStateRow[]> =>
  (
    await db.query<IFragmentStateRow>(
      `SELECT s.fragment_id, s.scope_item_id, s.state, e.origin, e.text, e.page_index, e.ordinal
         FROM registry_fragment_states($1) s JOIN evidence_fragment e ON e.id = s.fragment_id
        WHERE ($2::uuid IS NULL OR s.scope_item_id = $2) AND ($3::text IS NULL OR s.state = $3)
        ORDER BY s.scope_item_id, e.page_index NULLS LAST, e.ordinal NULLS LAST, e.part_index, e.id
        LIMIT $4 OFFSET $5`,
      [registryId, f.scopeItemId, f.state, f.limit, f.offset],
    )
  ).rows;

export type MarkSelector =
  | { kind: 'fragments'; fragmentIds: string[] }
  | { kind: 'page'; documentRevisionId: string; pageIndex: number }
  | { kind: 'document_revision'; documentRevisionId: string }
  | { kind: 'mail_message_revision'; mailMessageRevisionId: string }
  | { kind: 'qa_item_revision'; qaItemRevisionId: string }
  | { kind: 'transcript_revision'; transcriptRevisionId: string };

// Детерминированное развёртывание селектора в допустимые фрагменты снимка реестра (в порядке ID).
// Снятие отметки (cleared) — только у фрагментов, чья действующая отметка not_requirement.
export const expandMarkSelector = async (db: Queryable, registryId: string, sel: MarkSelector, mark: 'not_requirement' | 'cleared'): Promise<string[]> => {
  const where: Record<MarkSelectorKind, string> = {
    fragments: 'f.id = ANY($3::uuid[])',
    page: 'i.document_revision_id = $3::uuid AND f.page_index = $4::int',
    document_revision: 'i.document_revision_id = $3::uuid',
    mail_message_revision: 'i.mail_message_revision_id = $3::uuid',
    qa_item_revision: 'i.qa_item_revision_id = $3::uuid',
    transcript_revision: 'i.transcript_revision_id = $3::uuid',
  };
  const params: unknown[] = [registryId, REVIEWABLE_ORIGINS];
  switch (sel.kind) {
    case 'fragments':
      params.push(sel.fragmentIds);
      break;
    case 'page':
      params.push(sel.documentRevisionId, sel.pageIndex);
      break;
    case 'document_revision':
      params.push(sel.documentRevisionId);
      break;
    case 'mail_message_revision':
      params.push(sel.mailMessageRevisionId);
      break;
    case 'qa_item_revision':
      params.push(sel.qaItemRevisionId);
      break;
    case 'transcript_revision':
      params.push(sel.transcriptRevisionId);
      break;
  }
  const current = mark === 'cleared'
    ? `AND (SELECT m.mark FROM registry_fragment_mark m WHERE m.registry_id = $1 AND m.fragment_id = f.id ORDER BY m.seq DESC LIMIT 1) = 'not_requirement'`
    : '';
  const r = await db.query<{ id: string }>(
    `SELECT DISTINCT f.id
       FROM requirement_registry g
       JOIN evidence_scope_item i ON i.scope_id = g.evidence_scope_id
       JOIN evidence_fragment f ON f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id)
      WHERE g.id = $1 AND f.origin = ANY($2::text[]) AND ${where[sel.kind]} ${current}
      ORDER BY f.id`,
    params,
  );
  return r.rows.map((x) => x.id);
};

// Пакет и отметки — одной транзакцией; номер отметки — следующий по фрагменту (охранник держит блокировку реестра).
export const markFragments = async (
  db: Queryable,
  r: { tenderId: string; registryId: string; selector: MarkSelector; mark: 'not_requirement' | 'cleared'; reason: string | null; fragmentIds: string[]; userId: string },
): Promise<string> => {
  const { kind, ...selector } = r.selector;
  const b = await db.query<{ id: string }>(
    `INSERT INTO registry_mark_batch (tender_id, registry_id, selector_kind, selector, mark, reason, fragment_count, marked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [r.tenderId, r.registryId, kind, JSON.stringify(selector), r.mark, r.reason, r.fragmentIds.length, r.userId],
  );
  const batchId = b.rows[0]!.id;
  for (const fragmentId of r.fragmentIds) {
    await db.query(
      `INSERT INTO registry_fragment_mark (tender_id, registry_id, fragment_id, batch_id, seq, mark)
       VALUES ($1, $2, $3, $4, (SELECT coalesce(max(seq), 0) + 1 FROM registry_fragment_mark WHERE registry_id = $2 AND fragment_id = $3), $5)`,
      [r.tenderId, r.registryId, fragmentId, batchId, r.mark],
    );
  }
  return batchId;
};

export interface IRegistryReviewRow extends ICompletenessCounts {
  id: string;
  registry_id: string;
  seq: number;
  completed_by: string;
  completed_at: Date;
}

export const listRegistryReviews = async (db: Queryable, registryId: string): Promise<IRegistryReviewRow[]> =>
  (await db.query<IRegistryReviewRow>('SELECT * FROM requirement_registry_review WHERE registry_id = $1 ORDER BY seq DESC', [registryId])).rows;

// Завершение прохода: счётчики — из БД под блокировкой реестра; охранник пересчитывает их ещё раз.
export const completeRegistryReview = async (
  db: Queryable,
  r: { tenderId: string; registryId: string; userId: string },
): Promise<{ id: string; counts: ICompletenessCounts } | { unreviewed: number }> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('requirement_registry_review'), hashtext($1::text))", [r.registryId]);
  const c = await registryCompleteness(db, r.registryId);
  if (c.unreviewed_units > 0) return { unreviewed: c.unreviewed_units };
  const seq = await db.query<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM requirement_registry_review WHERE registry_id = $1', [r.registryId]);
  const ins = await db.query<{ id: string }>(
    `INSERT INTO requirement_registry_review (tender_id, registry_id, seq, total_units, reviewed_units, covered_units, explicit_not_requirement_units,
                                              unreviewed_units, empty_units, completed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [r.tenderId, r.registryId, seq.rows[0]!.n, c.total_units, c.reviewed_units, c.covered_units, c.explicit_not_requirement_units, c.unreviewed_units, c.empty_units, r.userId],
  );
  return { id: ins.rows[0]!.id, counts: c };
};
