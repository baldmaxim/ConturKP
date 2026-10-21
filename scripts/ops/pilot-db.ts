// Пилот (этап 18, проект §5): запросы к базе портала — только чтение. Соединение открывает openReadOnly: параметр
// сеанса default_transaction_read_only = on и одна транзакция READ ONLY на снимке REPEATABLE READ; любая запись
// (INSERT, UPDATE, DELETE, задания) отклоняется самой БД. Транзакция в конце откатывается. Результаты — идентификаторы
// и счётчики: названий и текстов источников запросы не читают.
import pg from 'pg';
import { PilotError } from './pilot-lib.ts';
import type { IUserActivity } from './pilot-activity.ts';
import type { ICandidateData } from './pilot-candidate.ts';
import type { IDeliveryFiles, IEconomicsView, IEvidenceCheck, IViolation, ReasonStatus } from './pilot-gates.ts';

export type Db = pg.Client;

export const openReadOnly = async (connectionString: string): Promise<Db> => {
  const client = new pg.Client({ connectionString, options: '-c default_transaction_read_only=on', application_name: 'kontur-pilot' });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    const r = await client.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
    if (r.rows[0]?.ro !== 'on') throw new PilotError('соединение не в режиме «только чтение»: работа остановлена');
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return client;
};

export const withReadOnly = async <T>(connectionString: string, fn: (db: Db) => Promise<T>): Promise<T> => {
  const db = await openReadOnly(connectionString);
  try {
    return await fn(db);
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    await db.end().catch(() => undefined);
  }
};

export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

// Раздел отчёта в точке сохранения: ошибка запроса (например, нет таблицы в старой схеме) не обрывает остальные.
export const section = async <T>(db: Db, fn: () => Promise<T>): Promise<Section<T>> => {
  await db.query('SAVEPOINT pilot_section');
  try {
    const value = await fn();
    await db.query('RELEASE SAVEPOINT pilot_section');
    return { ok: true, value };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT pilot_section');
    return { ok: false, error: (err instanceof Error ? err.message : 'ошибка запроса').split('\n')[0]!.slice(0, 200) };
  }
};

export const tenderExists = async (db: Db, tenderId: string): Promise<boolean> =>
  (await db.query('SELECT 1 FROM tender WHERE id = $1', [tenderId])).rowCount === 1;

const count = async (db: Db, sql: string, params: unknown[]): Promise<number> => (await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;

// ---------------------------------------------------------------- candidate

export const collectCandidate = async (db: Db, tenderId: string): Promise<ICandidateData> => {
  const p = [tenderId];
  const sends: Record<string, number> = {};
  for (const r of (await db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM send_event WHERE tender_id = $1 GROUP BY status ORDER BY status', p)).rows) sends[r.status] = r.n;
  const docs = await db.query<{ doc_type: string; documents: number; multi: number }>(
    `SELECT d.doc_type, count(*)::int AS documents, count(*) FILTER (WHERE rc.n >= 2)::int AS multi
       FROM document d
       JOIN LATERAL (SELECT count(*) AS n FROM document_revision r WHERE r.document_id = d.id) rc ON rc.n >= 1
      WHERE d.tender_id = $1 GROUP BY d.doc_type ORDER BY d.doc_type`,
    p,
  );
  const calc = await db.query<{ kind: string; n: number }>('SELECT kind, count(*)::int AS n FROM calculation_revision WHERE tender_id = $1 GROUP BY kind', p);
  const stages = await db.query<{ id: string; seq: number; status: string }>('SELECT id, seq, status FROM tender_stage WHERE tender_id = $1 ORDER BY seq', p);
  return {
    tenderId,
    sends,
    documentsByType: docs.rows.map((r) => ({ docType: r.doc_type, documents: r.documents, multiRevision: r.multi })),
    linkedContracts: await count(db, "SELECT count(*)::int AS n FROM contract_tender WHERE tender_id = $1 AND status = 'active'", p),
    linkedMailMessages: await count(db, "SELECT count(*)::int AS n FROM mail_message_tender WHERE tender_id = $1 AND status = 'linked'", p),
    qaThreads: await count(db, 'SELECT count(*)::int AS n FROM qa_thread WHERE tender_id = $1', p),
    negotiationSessions: await count(db, 'SELECT count(*)::int AS n FROM negotiation_session WHERE tender_id = $1', p),
    calculationRevisions: {
      provisional: calc.rows.find((r) => r.kind === 'provisional')?.n ?? 0,
      verified: calc.rows.find((r) => r.kind === 'verified')?.n ?? 0,
    },
    stages: stages.rows,
  };
};

// ---------------------------------------------------------------- report

// Фрагмент — источник этого тендера: его владелец тендер, либо договор, связанный с тендером (D-022).
const owned = (a: string): string =>
  `(coalesce(${a}.tender_id = $1, false) OR (${a}.tender_id IS NULL AND EXISTS (
      SELECT 1 FROM contract_tender ct WHERE ct.contract_id = ${a}.contract_id AND ct.tender_id = $1 AND ct.status = 'active')))`;

// Замечания тендера, которые обязаны быть размечены (кроме устаревших, status = stale).
export const portalFindingIds = async (db: Db, tenderId: string): Promise<string[]> =>
  (await db.query<{ id: string }>("SELECT id FROM finding WHERE tender_id = $1 AND status <> 'stale' ORDER BY id", [tenderId])).rows.map((r) => r.id);

// «Принятое» замечание — решённое человеком: resolved или accepted_risk (FINDING_STATUSES, HUMAN_FINDING_TRANSITIONS в
// packages/core/src/review/types.ts: из open/in_progress человек приводит к resolved, accepted_risk или rejected;
// rejected — отклонённое, не вывод; open, in_progress, stale — непринятые, UNSETTLED_FINDING_STATUSES). «Принятый» ответ —
// завершённый прогон со статусом confirmed_by_citations (все показанные утверждения подтверждены цитатами).
// Цитата отдельно от фрагмента в БД не хранится (finding_evidence.note — примечание, answer_claim хранит текст
// утверждения, а не цитату): дословность не проверяется, проверяется принадлежность и вход этапа или прогона.
export const collectG2 = async (db: Db, tenderId: string): Promise<{ checks: IEvidenceCheck[]; conclusions: { findings: number; answers: number } }> => {
  const p = [tenderId];
  const findings = await db.query<{ finding_id: string; fragment_id: string; owned: boolean; in_stage: boolean }>(
    `SELECT f.id AS finding_id, fe.fragment_id, (ef.id IS NOT NULL AND ${owned('ef')}) AS owned, fragment_in_stage(fe.fragment_id, f.stage_id) AS in_stage
       FROM finding f
       JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.fragment_id IS NOT NULL
       LEFT JOIN evidence_fragment ef ON ef.id = fe.fragment_id
      WHERE f.tender_id = $1 AND f.status IN ('resolved', 'accepted_risk')
      ORDER BY f.id, fe.id`,
    p,
  );
  const answers = await db.query<{ run_id: string; fragment_id: string; owned: boolean; in_scope: boolean }>(
    `SELECT ar.id AS run_id, ae.fragment_id, (ef.id IS NOT NULL AND ${owned('ef')}) AS owned,
            coalesce(ef.source_unit_id = ANY (sr.allowed_source_unit_ids), false) AS in_scope
       FROM dialog d
       JOIN answer_run ar ON ar.dialog_id = d.id AND ar.status = 'completed' AND ar.answer_status = 'confirmed_by_citations'
       JOIN search_run sr ON sr.id = ar.search_run_id
       JOIN answer_evidence ae ON ae.run_id = ar.id
       LEFT JOIN evidence_fragment ef ON ef.id = ae.fragment_id
      WHERE d.tender_id = $1
      ORDER BY ar.id, ae.ordinal`,
    p,
  );
  return {
    checks: [
      ...findings.rows.map((r): IEvidenceCheck => ({ kind: 'finding', objectId: r.finding_id, fragmentId: r.fragment_id, owned: r.owned, inScope: r.in_stage, quote: null })),
      ...answers.rows.map((r): IEvidenceCheck => ({ kind: 'answer', objectId: r.run_id, fragmentId: r.fragment_id, owned: r.owned, inScope: r.in_scope, quote: null })),
    ],
    conclusions: {
      findings: await count(db, "SELECT count(*)::int AS n FROM finding WHERE tender_id = $1 AND status IN ('resolved', 'accepted_risk')", p),
      answers: await count(
        db,
        `SELECT count(*)::int AS n FROM answer_run ar JOIN dialog d ON d.id = ar.dialog_id
          WHERE d.tender_id = $1 AND ar.status = 'completed' AND ar.answer_status = 'confirmed_by_citations'`,
        p,
      ),
    },
  };
};

const violation = async (db: Db, category: string, sql: string, tenderId: string): Promise<IViolation> => {
  const r = await db.query<{ id: string; total: number }>(`SELECT id, count(*) OVER ()::int AS total FROM (${sql}) q ORDER BY id LIMIT 20`, [tenderId]);
  return { category, count: r.rows[0]?.total ?? 0, ids: r.rows.map((x) => x.id) };
};

// G3: все основания (замечаний и ответов) и файлы выпусков — этого тендера; основания этапа — из его входа.
export const collectG3 = async (db: Db, tenderId: string): Promise<{ violations: IViolation[]; checked: Record<string, number> }> => {
  const p = [tenderId];
  const violations = [
    await violation(db, 'основание замечания другого тендера',
      `SELECT fe.id::text AS id FROM finding f JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE (f.tender_id = $1 OR fe.tender_id = $1) AND f.tender_id IS DISTINCT FROM fe.tender_id`, tenderId),
    await violation(db, 'фрагмент основания замечания не из источников тендера',
      `SELECT fe.id::text AS id FROM finding f JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.fragment_id IS NOT NULL
         JOIN evidence_fragment ef ON ef.id = fe.fragment_id WHERE f.tender_id = $1 AND NOT ${owned('ef')}`, tenderId),
    await violation(db, 'фрагмент основания замечания вне входа его этапа',
      `SELECT fe.id::text AS id FROM finding f JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.fragment_id IS NOT NULL
        WHERE f.tender_id = $1 AND NOT fragment_in_stage(fe.fragment_id, f.stage_id)`, tenderId),
    await violation(db, 'редакция документа основания замечания не из источников тендера',
      `SELECT fe.id::text AS id FROM finding f JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.document_revision_id IS NOT NULL
         JOIN document_revision dr ON dr.id = fe.document_revision_id
        WHERE f.tender_id = $1 AND NOT (coalesce(dr.tender_id = $1, false) OR (dr.tender_id IS NULL AND EXISTS (
          SELECT 1 FROM contract_tender ct WHERE ct.contract_id = dr.contract_id AND ct.tender_id = $1 AND ct.status = 'active')))`, tenderId),
    await violation(db, 'основание ответа не из источников тендера',
      `SELECT ae.run_id::text || ':' || ae.label AS id FROM dialog d JOIN answer_run ar ON ar.dialog_id = d.id
         JOIN answer_evidence ae ON ae.run_id = ar.id JOIN evidence_fragment ef ON ef.id = ae.fragment_id
        WHERE d.tender_id = $1 AND NOT ${owned('ef')}`, tenderId),
    await violation(db, 'основание ответа вне входа прогона поиска',
      `SELECT ae.run_id::text || ':' || ae.label AS id FROM dialog d JOIN answer_run ar ON ar.dialog_id = d.id
         JOIN search_run sr ON sr.id = ar.search_run_id JOIN answer_evidence ae ON ae.run_id = ar.id
         JOIN evidence_fragment ef ON ef.id = ae.fragment_id
        WHERE d.tender_id = $1 AND NOT coalesce(ef.source_unit_id = ANY (sr.allowed_source_unit_ids), false)`, tenderId),
    await violation(db, 'поиск ответа относится к другому тендеру',
      `SELECT ar.id::text AS id FROM dialog d JOIN answer_run ar ON ar.dialog_id = d.id JOIN search_run sr ON sr.id = ar.search_run_id
        WHERE d.tender_id = $1 AND sr.tender_id <> d.tender_id`, tenderId),
    await violation(db, 'кандидат выпуска другого тендера',
      `SELECT r.id::text AS id FROM release r JOIN release_candidate c ON c.id = r.candidate_id WHERE r.tender_id = $1 AND c.tender_id <> r.tender_id`, tenderId),
    await violation(db, 'файл выпуска из черновика другого тендера',
      `SELECT cf.id::text AS id FROM release r JOIN candidate_file cf ON cf.candidate_id = r.candidate_id
         JOIN application_draft ad ON ad.id = cf.draft_id WHERE r.tender_id = $1 AND ad.tender_id <> $1`, tenderId),
    await violation(db, 'файл выпуска из шаблона другого тендера',
      `SELECT cf.id::text AS id FROM release r JOIN candidate_file cf ON cf.candidate_id = r.candidate_id
         JOIN template_revision tr ON tr.id = cf.template_revision_id WHERE r.tender_id = $1 AND tr.tender_id IS NOT NULL AND tr.tender_id <> $1`, tenderId),
    await violation(db, 'файл выпуска из вложения другого тендера',
      `SELECT cf.id::text AS id FROM release r JOIN candidate_file cf ON cf.candidate_id = r.candidate_id
         JOIN standard_attachment_revision sar ON sar.id = cf.attachment_revision_id JOIN standard_attachment sa ON sa.id = sar.attachment_id
        WHERE r.tender_id = $1 AND sa.scope_tender_id IS NOT NULL AND sa.scope_tender_id <> $1`, tenderId),
    await violation(db, 'размещение другого тендера у выпуска',
      `SELECT d.id::text AS id FROM delivery d JOIN release r ON r.id = d.release_id WHERE (d.tender_id = $1 OR r.tender_id = $1) AND d.tender_id <> r.tender_id`, tenderId),
  ];
  return {
    violations,
    checked: {
      'оснований замечаний': await count(db, 'SELECT count(*)::int AS n FROM finding_evidence WHERE tender_id = $1', p),
      'оснований ответов': await count(db, 'SELECT count(*)::int AS n FROM answer_evidence ae JOIN answer_run ar ON ar.id = ae.run_id JOIN dialog d ON d.id = ar.dialog_id WHERE d.tender_id = $1', p),
      выпусков: await count(db, 'SELECT count(*)::int AS n FROM release WHERE tender_id = $1', p),
      'файлов выпусков': await count(db, 'SELECT count(*)::int AS n FROM release r JOIN candidate_file cf ON cf.candidate_id = r.candidate_id WHERE r.tender_id = $1', p),
      размещений: await count(db, 'SELECT count(*)::int AS n FROM delivery WHERE tender_id = $1', p),
    },
  };
};

// G4: отчёт сверки (revision_economics, 0026) последней по времени ревизии расчёта тендера.
export const collectG4 = async (db: Db, tenderId: string): Promise<IEconomicsView | null> => {
  const r = await db.query<{ revision_id: string; stage_id: string; seq: number; method_version: string | null; status: string | null; residual: string | null; tolerance: string | null }>(
    `SELECT cr.id AS revision_id, cr.stage_id, cr.seq, e.method_version, e.reconciliation_status AS status, e.residual::text AS residual, e.tolerance::text AS tolerance
       FROM calculation_revision cr
       LEFT JOIN LATERAL (SELECT * FROM revision_economics x WHERE x.revision_id = cr.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) e ON true
      WHERE cr.tender_id = $1 ORDER BY cr.created_at DESC, cr.id DESC LIMIT 1`,
    [tenderId],
  );
  const x = r.rows[0];
  return x ? { revisionId: x.revision_id, stageId: x.stage_id, seq: x.seq, methodVersion: x.method_version, reconciliationStatus: x.status, residual: x.residual, tolerance: x.tolerance } : null;
};

// G5: размещения тендера, кроме заменённых (superseded); состояние каждого файла набора — delivery_file_state.remote_state.
export const collectG5 = async (db: Db, tenderId: string): Promise<IDeliveryFiles> => {
  const d = await count(db, "SELECT count(*)::int AS n FROM delivery WHERE tender_id = $1 AND status <> 'superseded'", [tenderId]);
  const f = await db.query<{ remote_state: string; n: number }>(
    `SELECT s.remote_state, count(*)::int AS n FROM delivery d JOIN delivery_file_state s ON s.delivery_id = d.id
      WHERE d.tender_id = $1 AND d.status <> 'superseded' GROUP BY s.remote_state ORDER BY s.remote_state`,
    [tenderId],
  );
  const byState: Record<string, number> = {};
  for (const r of f.rows) byState[r.remote_state] = r.n;
  return { deliveries: d, files: f.rows.reduce((n, r) => n + r.n, 0), byState };
};

// М4: статус причины (change_explanation.reason_status) по идентификаторам версий причины, названным в сопоставлении.
export const collectReasonStatuses = async (db: Db, tenderId: string, ids: readonly string[]): Promise<Map<string, ReasonStatus>> => {
  const r = await db.query<{ id: string; reason_status: ReasonStatus }>('SELECT id, reason_status FROM change_explanation WHERE tender_id = $1 AND id = ANY ($2::uuid[])', [tenderId, [...ids]]);
  return new Map(r.rows.map((x) => [x.id.toLowerCase(), x.reason_status]));
};

// М5: действия участников тендера (назначения, в том числе снятые) по audit_event: человек, разрешённые действия.
export const collectActivity = async (db: Db, tenderId: string): Promise<IUserActivity[]> => {
  const members = await db.query<{ user_id: string; roles: string[] }>(
    'SELECT user_id, array_agg(DISTINCT member_role ORDER BY member_role) AS roles FROM tender_member WHERE tender_id = $1 GROUP BY user_id ORDER BY user_id',
    [tenderId],
  );
  const events = await db.query<{ actor_user_id: string; occurred_at: Date }>(
    `SELECT actor_user_id, occurred_at FROM audit_event
      WHERE tender_id = $1 AND principal_kind = 'human' AND outcome = 'allowed' AND actor_user_id IN (SELECT user_id FROM tender_member WHERE tender_id = $1)
      ORDER BY actor_user_id, occurred_at`,
    [tenderId],
  );
  const byUser = new Map<string, Date[]>();
  for (const e of events.rows) byUser.set(e.actor_user_id, [...(byUser.get(e.actor_user_id) ?? []), e.occurred_at]);
  return members.rows.map((m) => ({ userId: m.user_id, roles: m.roles, eventTimes: byUser.get(m.user_id) ?? [] }));
};
