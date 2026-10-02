// Разногласия этапа 09 (I08, I09; D-029): четыре независимые оси — события человека с основаниями; приоритет
// источников по тендеру (В-09-1); читаемость редакций документов и писем для показа производного текста (R08-02).
import { AXIS_DEFAULTS, DISCREPANCY_AXIS_KEYS, type DiscrepancyAxis, type IEvidenceDraft } from '@kontur/core';
import { contentTenderIds, readableContractIds, readableMailboxIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';
import { dependenciesOf, insertDependencies } from './reviewRuns.ts';

// ---------------------------------------------------------------- Разногласия и оси (I08, I09)

export interface IDiscrepancyRow {
  id: string;
  tender_id: string;
  stage_id: string;
  finding_id: string;
  topic: string;
  created_by_name: string;
  created_at: Date;
}

export const getDiscrepancy = async (db: Queryable, id: string): Promise<IDiscrepancyRow | null> =>
  (
    await db.query<IDiscrepancyRow>(
      'SELECT d.id, d.tender_id, d.stage_id, d.finding_id, d.topic, u.display_name AS created_by_name, d.created_at FROM discrepancy d JOIN app_user u ON u.id = d.created_by WHERE d.id = $1',
      [id],
    )
  ).rows[0] ?? null;

export const listDiscrepancies = async (db: Queryable, stageId: string): Promise<IDiscrepancyRow[]> =>
  (
    await db.query<IDiscrepancyRow>(
      `SELECT d.id, d.tender_id, d.stage_id, d.finding_id, d.topic, u.display_name AS created_by_name, d.created_at
         FROM discrepancy d JOIN app_user u ON u.id = d.created_by WHERE d.stage_id = $1 ORDER BY d.created_at, d.id`,
      [stageId],
    )
  ).rows;

export const createDiscrepancy = async (db: Queryable, d: { tenderId: string; stageId: string; findingId: string; topic: string; userId: string }): Promise<string> =>
  (
    await db.query<{ id: string }>('INSERT INTO discrepancy (tender_id, stage_id, finding_id, topic, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      d.tenderId,
      d.stageId,
      d.findingId,
      d.topic,
      d.userId,
    ])
  ).rows[0]!.id;

export interface IAxisEventRow {
  id: string;
  discrepancy_id: string;
  seq: number;
  axis: DiscrepancyAxis;
  value: string;
  reason: string;
  actor_name: string;
  created_at: Date;
  invalidated_reason: string | null;
  bases: { basis_type: string; fragment_id: string | null; qa_item_revision_id: string | null; mail_message_revision_id: string | null; document_revision_id: string | null; decision_id: string | null }[];
}

export const axisEvents = async (db: Queryable, discrepancyIds: readonly string[]): Promise<IAxisEventRow[]> =>
  discrepancyIds.length === 0
    ? []
    : (
        await db.query<IAxisEventRow>(
          `SELECT e.id, e.discrepancy_id, e.seq, e.axis, e.value, e.reason, u.display_name AS actor_name, e.created_at,
                  (SELECT i.reason FROM evidence_invalidation i WHERE i.dependent_type = 'discrepancy_status_event' AND i.dependent_id = e.id ORDER BY i.created_at LIMIT 1) AS invalidated_reason,
                  coalesce((SELECT jsonb_agg(jsonb_build_object('basis_type', b.basis_type, 'fragment_id', b.fragment_id, 'qa_item_revision_id', b.qa_item_revision_id,
                                                                'mail_message_revision_id', b.mail_message_revision_id, 'document_revision_id', b.document_revision_id,
                                                                'decision_id', b.decision_id) ORDER BY b.id)
                              FROM discrepancy_basis b WHERE b.event_id = e.id), '[]'::jsonb) AS bases
             FROM discrepancy_status_event e JOIN app_user u ON u.id = e.actor_user_id
            WHERE e.discrepancy_id = ANY($1::uuid[]) ORDER BY e.discrepancy_id, e.seq`,
          [[...discrepancyIds]],
        )
      ).rows;

// Текущие значения осей: последнее событие оси или значение по умолчанию; у каждой оси — своё событие (I09).
export const currentAxes = (events: readonly IAxisEventRow[]): Record<DiscrepancyAxis, { value: string; event: IAxisEventRow | null }> => {
  const out = {} as Record<DiscrepancyAxis, { value: string; event: IAxisEventRow | null }>;
  for (const axis of DISCREPANCY_AXIS_KEYS) {
    const last = events.filter((e) => e.axis === axis).at(-1) ?? null;
    out[axis] = { value: last?.value ?? AXIS_DEFAULTS[axis], event: last };
  }
  return out;
};

export interface IAxisBasis {
  type: 'fragment' | 'qa_item_revision' | 'mail_message_revision' | 'document_revision' | 'decision';
  id: string;
}

export const insertAxisEvent = async (
  db: Queryable,
  e: { discrepancy: IDiscrepancyRow; axis: DiscrepancyAxis; value: string; reason: string; userId: string; bases: readonly IAxisBasis[] },
): Promise<string> => {
  // Разногласие неизменяемо (нет UPDATE у роли приложения): номера событий сериализуются advisory-блокировкой.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('discrepancy'), hashtext($1::text))", [e.discrepancy.id]);
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO discrepancy_status_event (discrepancy_id, tender_id, seq, axis, value, reason, actor_user_id)
       VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM discrepancy_status_event WHERE discrepancy_id = $1), $3, $4, $5, $6) RETURNING id`,
      [e.discrepancy.id, e.discrepancy.tender_id, e.axis, e.value, e.reason, e.userId],
    )
  ).rows[0]!.id;
  const col: Record<IAxisBasis['type'], string> = {
    fragment: 'fragment_id',
    qa_item_revision: 'qa_item_revision_id',
    mail_message_revision: 'mail_message_revision_id',
    document_revision: 'document_revision_id',
    decision: 'decision_id',
  };
  for (const b of e.bases) {
    await db.query(`INSERT INTO discrepancy_basis (event_id, tender_id, basis_type, ${col[b.type]}) VALUES ($1, $2, $3, $4)`, [id, e.discrepancy.tender_id, b.type, b.id]);
  }
  const fragments: IEvidenceDraft[] = e.bases.filter((b) => b.type === 'fragment').map((b) => ({ side: 'context', objectType: 'fragment', fragmentId: b.id }));
  const refs = [
    ...(await dependenciesOf(db, fragments)),
    ...e.bases.filter((b) => b.type !== 'fragment').map((b) => ({ type: b.type, id: b.id })),
  ];
  await insertDependencies(db, { tenderId: e.discrepancy.tender_id, stageId: e.discrepancy.stage_id, dependentType: 'discrepancy_status_event', dependentId: id, refs });
  return id;
};

// ---------------------------------------------------------------- Приоритет источников (D-029, В-09-1)

export interface ISourcePriorityRow {
  id: string;
  seq: number;
  kinds: string[];
  reason: string;
  created_by_name: string;
  created_at: Date;
}

export const sourcePriorityRevisions = async (db: Queryable, tenderId: string): Promise<ISourcePriorityRow[]> =>
  (
    await db.query<ISourcePriorityRow>(
      `SELECT p.id, p.seq, p.kinds, p.reason, u.display_name AS created_by_name, p.created_at
         FROM source_priority_revision p JOIN app_user u ON u.id = p.created_by WHERE p.tender_id = $1 ORDER BY p.seq DESC`,
      [tenderId],
    )
  ).rows;

export const insertSourcePriority = async (db: Queryable, p: { tenderId: string; kinds: readonly string[]; reason: string; userId: string }): Promise<string> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('source_priority'), hashtext($1::text))", [p.tenderId]);
  return (
    await db.query<{ id: string }>(
      `INSERT INTO source_priority_revision (tender_id, seq, kinds, reason, created_by)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM source_priority_revision WHERE tender_id = $1), $2, $3, $4) RETURNING id`,
      [p.tenderId, p.kinds, p.reason, p.userId],
    )
  ).rows[0]!.id;
};

// ---------------------------------------------------------------- Видимость (R08-02)

// Редакции документов, которые пользователь может читать: тендера — доступ к тендеру, договора — contract.read,
// вложения письма — mail.read.
export const readableDocumentRevisions = async (db: Queryable, ctx: IAccessContext, ids: readonly string[]): Promise<Set<string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const r = await db.query<{ id: string }>(
    `SELECT dr.id FROM document_revision dr JOIN document d ON d.id = dr.document_id
       LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
       LEFT JOIN mail_message_revision amr ON amr.id = a.revision_id
       LEFT JOIN mail_message am ON am.id = amr.message_id
      WHERE dr.id = ANY($1::uuid[])
        AND ((dr.tender_id = ANY($2::uuid[]) AND d.mail_attachment_id IS NULL) OR dr.contract_id = ANY($3::uuid[]) OR am.mailbox_id = ANY($4::uuid[]))`,
    [unique, contentTenderIds(ctx), readableContractIds(ctx), readableMailboxIds(ctx)],
  );
  return new Set(r.rows.map((x) => x.id));
};

export const readableMailRevisions = async (db: Queryable, ctx: IAccessContext, ids: readonly string[]): Promise<Set<string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const r = await db.query<{ id: string }>(
    'SELECT r.id FROM mail_message_revision r JOIN mail_message m ON m.id = r.message_id WHERE r.id = ANY($1::uuid[]) AND m.mailbox_id = ANY($2::uuid[])',
    [unique, readableMailboxIds(ctx)],
  );
  return new Set(r.rows.map((x) => x.id));
};
