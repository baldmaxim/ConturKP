// Согласование и выпуск кандидата (этап 13; D-033; state-machines §11, §13–§15): факты матрицы блокеров, принятие риска,
// согласование, возврат, отзыв, выпуск и удержания по событиям входов. Команды вызываются под блокировкой этапа
// (порядок «этап → кандидат → согласование и выпуск», §1.2); правила покрытия и вторая линия — миграция 0034.
import type { BlockerCode, IGateItem, IRiskAcceptanceFact, RiskSubjectType } from '@kontur/core';
import type { Queryable } from './pool.ts';
import type { CandidateStatus, IReleaseCandidateRow } from './releaseCandidates.ts';

export interface IApprovalRow {
  id: string;
  candidate_id: string;
  tender_id: string;
  stage_id: string;
  candidate_content_hash: string;
  input_version: number;
  gate: Record<string, unknown>;
  accepted_risk_ids: string[];
  comment: string | null;
  approved_by: string;
  approved_by_name: string;
  approved_at: Date;
  status: 'active' | 'revoked' | 'superseded';
  revoked_by: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  ended_at: Date | null;
  row_version: number;
}

export interface IReleaseRow {
  id: string;
  candidate_id: string;
  approval_id: string;
  tender_id: string;
  stage_id: string;
  mode: 'test' | 'production';
  input_version: number;
  content_hash: string;
  release_manifest_blob_sha256: string;
  release_manifest_sha256: string;
  gate: Record<string, unknown>;
  released_by: string;
  released_by_name: string;
  released_at: Date;
  candidate_seq: number;
}

export interface IRiskAcceptanceRow {
  id: string;
  candidate_id: string;
  blocker_code: BlockerCode;
  subject_type: RiskSubjectType;
  subject_id: string;
  subject_key: string;
  subject_version: number | null;
  reason: string;
  accepted_by: string;
  accepted_by_name: string;
  accepted_at: Date;
}

export interface IHoldRow {
  id: string;
  candidate_id: string;
  candidate_seq: number;
  candidate_status: CandidateStatus;
  tender_id: string;
  stage_id: string;
  input_event_id: string;
  event_seq: number;
  event_type: string;
  event_class: string;
  ref_type: string;
  ref_id: string;
  event_at: Date;
  status: 'open' | 'resolved_not_applicable' | 'resolved_requires_new_candidate';
  decision_id: string | null;
  reason: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  created_at: Date;
  row_version: number;
  covered: boolean;
}

export interface ICandidateReturnRow {
  candidate_id: string;
  reason: string;
  hold_id: string | null;
  returned_by: string;
  returned_by_name: string;
  returned_at: Date;
}

// ---------------------------------------------------------------- Чтение

const APPROVAL_SELECT = `SELECT a.*, u.display_name AS approved_by_name, r.display_name AS revoked_by_name
  FROM approval a JOIN app_user u ON u.id = a.approved_by LEFT JOIN app_user r ON r.id = a.revoked_by`;

const approvalOf = (r: IApprovalRow): IApprovalRow => ({ ...r, input_version: Number(r.input_version), row_version: Number(r.row_version) });

export const getApproval = async (db: Queryable, id: string, lock = false): Promise<IApprovalRow | null> => {
  const r = (await db.query<IApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id])).rows[0];
  return r ? approvalOf(r) : null;
};

export const listApprovals = async (db: Queryable, candidateId: string): Promise<IApprovalRow[]> =>
  (await db.query<IApprovalRow>(`${APPROVAL_SELECT} WHERE a.candidate_id = $1 ORDER BY a.approved_at, a.id`, [candidateId])).rows.map(approvalOf);

export const activeApproval = async (db: Queryable, candidateId: string): Promise<IApprovalRow | null> =>
  (await listApprovals(db, candidateId)).find((a) => a.status === 'active') ?? null;

const RELEASE_SELECT = `SELECT r.*, u.display_name AS released_by_name, c.seq AS candidate_seq
  FROM release r JOIN app_user u ON u.id = r.released_by JOIN release_candidate c ON c.id = r.candidate_id`;

const releaseOf = (r: IReleaseRow): IReleaseRow => ({ ...r, input_version: Number(r.input_version), candidate_seq: Number(r.candidate_seq) });

export const getRelease = async (db: Queryable, id: string): Promise<IReleaseRow | null> => {
  const r = (await db.query<IReleaseRow>(`${RELEASE_SELECT} WHERE r.id = $1`, [id])).rows[0];
  return r ? releaseOf(r) : null;
};

export const releaseOfCandidate = async (db: Queryable, candidateId: string): Promise<IReleaseRow | null> => {
  const r = (await db.query<IReleaseRow>(`${RELEASE_SELECT} WHERE r.candidate_id = $1`, [candidateId])).rows[0];
  return r ? releaseOf(r) : null;
};

export const listReleases = async (db: Queryable, stageId: string): Promise<IReleaseRow[]> =>
  (await db.query<IReleaseRow>(`${RELEASE_SELECT} WHERE r.stage_id = $1 ORDER BY r.released_at DESC, r.id`, [stageId])).rows.map(releaseOf);

export const listAcceptances = async (db: Queryable, candidateId: string): Promise<IRiskAcceptanceRow[]> =>
  (
    await db.query<IRiskAcceptanceRow>(
      `SELECT r.*, u.display_name AS accepted_by_name FROM risk_acceptance r JOIN app_user u ON u.id = r.accepted_by
        WHERE r.candidate_id = $1 ORDER BY r.accepted_at, r.id`,
      [candidateId],
    )
  ).rows.map((r) => ({ ...r, subject_version: r.subject_version === null ? null : Number(r.subject_version) }));

export const acceptanceFact = (r: IRiskAcceptanceRow): IRiskAcceptanceFact => ({
  id: r.id,
  blockerCode: r.blocker_code,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  subjectKey: r.subject_key,
  subjectVersion: r.subject_version,
  reason: r.reason,
  acceptedBy: r.accepted_by_name,
  acceptedAt: r.accepted_at.toISOString(),
});

export const candidateReturn = async (db: Queryable, candidateId: string): Promise<ICandidateReturnRow | null> =>
  (
    await db.query<ICandidateReturnRow>(
      'SELECT r.*, u.display_name AS returned_by_name FROM candidate_return r JOIN app_user u ON u.id = r.returned_by WHERE r.candidate_id = $1',
      [candidateId],
    )
  ).rows[0] ?? null;

const HOLD_SELECT = `SELECT h.*, c.seq AS candidate_seq, c.status AS candidate_status, e.seq AS event_seq, e.event_type, e.event_class, e.ref_type, e.ref_id,
       e.created_at AS event_at, d.rationale AS reason, u.display_name AS resolved_by_name, stage_event_covered(h.candidate_id, h.input_event_id) AS covered
  FROM readiness_hold h JOIN release_candidate c ON c.id = h.candidate_id JOIN stage_input_event e ON e.id = h.input_event_id
  LEFT JOIN decision d ON d.id = h.decision_id LEFT JOIN app_user u ON u.id = h.resolved_by`;

const holdOf = (r: IHoldRow): IHoldRow => ({ ...r, event_seq: Number(r.event_seq), candidate_seq: Number(r.candidate_seq), row_version: Number(r.row_version) });

export const getHold = async (db: Queryable, id: string, lock = false): Promise<IHoldRow | null> => {
  const r = (await db.query<IHoldRow>(`${HOLD_SELECT} WHERE h.id = $1${lock ? ' FOR UPDATE OF h' : ''}`, [id])).rows[0];
  return r ? holdOf(r) : null;
};

export const listHolds = async (
  db: Queryable,
  stageId: string,
  f: { candidateId?: string | undefined; status?: IHoldRow['status'] | undefined; limit?: number } = {},
): Promise<IHoldRow[]> =>
  (
    await db.query<IHoldRow>(
      `${HOLD_SELECT} WHERE h.stage_id = $1 AND ($2::uuid IS NULL OR h.candidate_id = $2) AND ($3::text IS NULL OR h.status = $3)
        ORDER BY c.seq DESC, e.seq LIMIT $4`,
      [stageId, f.candidateId ?? null, f.status ?? null, f.limit ?? 500],
    )
  ).rows.map(holdOf);

// ---------------------------------------------------------------- Факты матрицы (без прав и сверки байтов)

export interface ICandidateGateDbFacts {
  reviewMissing: boolean;
  reviewScopeMismatch: boolean;
  reviewProcessing: IGateItem[];
  reviewUncertain: IGateItem[];
  uncoveredEvents: IGateItem[];
  staleChannels: IGateItem[];
  fieldsStale: IGateItem[];
  calculationProvisional: boolean;
  templateDemo: boolean;
  kpTotalMissing: boolean;
  criticalFindings: IGateItem[];
  questions: IGateItem[];
  draftQuestions: IGateItem[];
  numbersUnverified: IGateItem[];
  // Риски, принятые в этапе 09 и действующие (замечание `accepted_risk` после обработки событий этапа, D-033 ут. 3).
  reviewRisks: { findingId: string; kind: string; severity: string; title: string; reason: string; acceptedBy: string | null; acceptedById: string | null; acceptedAt: Date | null }[];
}

const CHECK_TITLES: Record<string, string> = {
  processing: 'Полнота обработки источников',
  registry: 'Полнота реестра требований',
  coverage: 'Покрытие требований расчётом',
  parameters: 'Параметры требований в строках расчёта',
  units: 'Единицы требований и расчёта',
  quantities: 'Количества, дубли и объёмы',
  obligations: 'Договорные обязательства',
  pd_uncertainty: 'Неопределённость ПД',
  source_conflicts: 'Конфликты источников',
  customer_silence: 'Молчание заказчика',
  stale_basis: 'Устаревшие основания',
  model_hypotheses: 'Гипотезы модели',
};

const EVENT_TITLES: Record<string, string> = {
  import_accepted: 'принята загрузка файлов',
  document_revision_registered: 'новая редакция документа',
  source_set_changed: 'изменён набор источников',
  recognition_run_completed: 'завершено распознавание',
  calculation_revision_added: 'новая ревизия расчёта',
  communication_linked: 'письмо связано с тендером',
  transcript_revision_added: 'новая редакция транскрипции',
  qa_form_added: 'новые вопросы–ответы',
  decision_recorded: 'записано решение',
  draft_field_changed: 'изменено поле приложения',
};

export const eventTitle = (type: string): string => EVENT_TITLES[type] ?? type;

export const candidateGateDbFacts = async (db: Queryable, c: IReleaseCandidateRow): Promise<ICandidateGateDbFacts> => {
  const q = async <T extends object>(sql: string, params: unknown[]): Promise<T[]> => (await db.query<T>(sql, params)).rows;
  const runs = await q<{ id: string; status: string; evidence_scope_id: string; calculation_revision_id: string | null }>(
    `SELECT r.id, r.status, r.evidence_scope_id, r.calculation_revision_id FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id
      WHERE ci.candidate_id = $1 AND ci.kind = 'review_run' ORDER BY ci.ordinal`,
    [c.id],
  );
  const finished = runs.filter((r) => r.status === 'completed' || r.status === 'completed_with_gaps');
  const results = await q<{ id: string; check_code: string; outcome: string; reason: string | null }>(
    `SELECT x.id, x.check_code, x.outcome, x.reason FROM review_check_result x WHERE x.run_id = ANY($1::uuid[]) AND x.outcome IN ('incomplete', 'error')
      ORDER BY x.check_code`,
    [finished.map((r) => r.id)],
  );
  const resultItem = (x: { id: string; check_code: string; outcome: string; reason: string | null }): IGateItem => ({
    subjectType: 'review_check_result',
    subjectId: x.id,
    title: `${CHECK_TITLES[x.check_code] ?? x.check_code}: ${x.outcome === 'error' ? 'ошибка' : 'неполно'}${x.reason ? ` — ${x.reason}` : ''}`,
  });
  const uncovered = await q<{ id: string; seq: number; event_type: string; hold_status: string | null }>(
    `SELECT e.id, e.seq, e.event_type, h.status AS hold_status FROM candidate_uncovered_events($1) u(id) JOIN stage_input_event e ON e.id = u.id
       LEFT JOIN readiness_hold h ON h.candidate_id = $1 AND h.input_event_id = e.id ORDER BY e.seq`,
    [c.id],
  );
  const channels = await q<{ id: string; locator: string; last_successful_scan_at: Date | null }>(
    `SELECT id, locator, last_successful_scan_at FROM intake_channel
      WHERE tender_id = $1 AND active AND (last_successful_scan_at IS NULL OR last_successful_scan_at < now() - freshness_window) ORDER BY created_at, id`,
    [c.tender_id],
  );
  const stale = await q<{ id: string; field_key: string; draft_title: string; problem: string | null; invalidated: boolean }>(
    `SELECT v.id, f.field_key, a.title AS draft_title, field_version_basis_problem($2, v.id) AS problem, field_version_invalidated(v.id) AS invalidated
       FROM candidate_input ci JOIN draft_field_version v ON v.id = ci.ref_id JOIN draft_field f ON f.id = v.field_id JOIN application_draft a ON a.id = v.draft_id
      WHERE ci.candidate_id = $1 AND ci.kind = 'field_version'
        AND (field_version_basis_problem($2, v.id) IS NOT NULL OR field_version_invalidated(v.id)) ORDER BY a.title, f.field_key`,
    [c.id, c.stage_id],
  );
  const calc = (
    await q<{ kind: string; kp_total_rule: string | null }>(
      'SELECT r.kind, cc.kp_total_rule FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id WHERE r.id = $1',
      [c.calculation_revision_id],
    )
  )[0]!;
  const demo = await q<{ x: number }>(
    `SELECT 1 AS x FROM candidate_input ci JOIN template_revision r ON r.id = ci.ref_id JOIN application_template t ON t.id = r.template_id
      WHERE ci.candidate_id = $1 AND ci.kind = 'template_revision' AND t.is_demo LIMIT 1`,
    [c.id],
  );
  const findings = await q<{ id: string; title: string; status: string; row_version: number }>(
    `SELECT id, title, status, row_version FROM finding WHERE stage_id = $1 AND severity = 'critical' AND status IN ('open', 'in_progress', 'stale') ORDER BY created_at, id`,
    [c.stage_id],
  );
  const questions = await q<{ id: string; text: string; status: string; row_version: number }>(
    `SELECT id, text, status, row_version FROM customer_question WHERE stage_id = $1 AND status IN ('draft', 'sent') ORDER BY created_at, id`,
    [c.stage_id],
  );
  const numbers = await q<{ id: string; path: string | null; detail: string | null }>(
    `SELECT id, path, detail FROM candidate_check WHERE candidate_id = $1 AND code = 'numbers_match_calculation' AND outcome = 'unverified' ORDER BY ordinal`,
    [c.id],
  );
  const reviewRisks = await q<{ id: string; kind: string; severity: string; title: string; reason: string | null; accepted_by: string | null; accepted_by_id: string | null; accepted_at: Date | null }>(
    `SELECT f.id, f.kind, f.severity, f.title, ev.reason, u.display_name AS accepted_by, ev.actor_user_id AS accepted_by_id, ev.created_at AS accepted_at
       FROM finding f
       LEFT JOIN LATERAL (SELECT e.reason, e.actor_user_id, e.created_at FROM finding_event e
                           WHERE e.finding_id = f.id AND e.event_kind = 'status' AND e.to_value = 'accepted_risk' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) ev ON true
       LEFT JOIN app_user u ON u.id = ev.actor_user_id
      WHERE f.stage_id = $1 AND f.status = 'accepted_risk' ORDER BY f.created_at, f.id`,
    [c.stage_id],
  );
  const qTitle = (t: string) => (t.length > 140 ? `${t.slice(0, 139)}…` : t);
  return {
    reviewMissing: finished.length === 0,
    reviewScopeMismatch: finished.some((r) => r.evidence_scope_id !== c.evidence_scope_id || r.calculation_revision_id !== c.calculation_revision_id),
    reviewProcessing: results.filter((x) => x.outcome === 'error' || x.check_code !== 'coverage').map(resultItem),
    reviewUncertain: results.filter((x) => x.outcome === 'incomplete' && x.check_code === 'coverage').map(resultItem),
    uncoveredEvents: uncovered.map((e) => ({
      subjectType: 'stage_input_event',
      subjectId: e.id,
      title: `№ ${e.seq}: ${eventTitle(e.event_type)}${e.hold_status === 'resolved_requires_new_candidate' ? ' — решено «влияет»' : ''}`,
    })),
    staleChannels: channels.map((ch) => ({ subjectType: 'intake_channel', subjectId: ch.id, title: `${ch.locator}: ${ch.last_successful_scan_at ? 'скан устарел' : 'скана не было'}` })),
    fieldsStale: stale.map((v) => ({
      subjectType: 'field_version',
      subjectId: v.id,
      title: `«${v.draft_title}», поле ${v.field_key}: ${v.invalidated ? 'основание изменилось' : `основание заменено (${v.problem})`}`,
    })),
    calculationProvisional: calc.kind === 'provisional',
    templateDemo: demo.length > 0,
    kpTotalMissing: calc.kp_total_rule === null,
    criticalFindings: findings.map((f) => ({ subjectType: 'finding', subjectId: f.id, subjectVersion: Number(f.row_version), title: `${qTitle(f.title)}${f.status === 'stale' ? ' (основание изменилось)' : ''}` })),
    questions: questions.filter((x) => x.status === 'sent').map((x) => ({ subjectType: 'customer_question', subjectId: x.id, subjectVersion: Number(x.row_version), title: qTitle(x.text) })),
    draftQuestions: questions.filter((x) => x.status === 'draft').map((x) => ({ subjectType: 'customer_question', subjectId: x.id, title: qTitle(x.text) })),
    numbersUnverified: numbers.map((k) => ({ subjectType: 'candidate_check', subjectId: k.id, title: `${k.path ?? 'число'}${k.detail ? `: ${k.detail}` : ''}` })),
    reviewRisks: reviewRisks.map((f) => ({
      findingId: f.id,
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      reason: f.reason ?? '',
      acceptedBy: f.accepted_by,
      acceptedById: f.accepted_by_id,
      acceptedAt: f.accepted_at,
    })),
  };
};

// ---------------------------------------------------------------- Команды (вызывающий держит блокировку этапа)

export const setCandidateStatus = async (db: Queryable, id: string, status: CandidateStatus): Promise<void> => {
  await db.query('UPDATE release_candidate SET status = $2, row_version = row_version + 1 WHERE id = $1', [id, status]);
};

export const insertRiskAcceptance = async (
  db: Queryable,
  a: { candidate: IReleaseCandidateRow; code: BlockerCode; item: IGateItem; reason: string; userId: string },
): Promise<string> =>
  (
    await db.query<{ id: string }>(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, subject_key, subject_version, reason, accepted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [a.candidate.id, a.candidate.tender_id, a.candidate.stage_id, a.code, a.item.subjectType, a.item.subjectId, a.item.subjectKey ?? '', a.item.subjectVersion ?? null, a.reason, a.userId],
    )
  ).rows[0]!.id;

export const insertApproval = async (
  db: Queryable,
  a: { candidate: IReleaseCandidateRow; inputVersion: number; gate: object; acceptedRiskIds: string[]; comment: string | null; userId: string },
): Promise<string> => {
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, accepted_risk_ids, comment, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [a.candidate.id, a.candidate.tender_id, a.candidate.stage_id, a.candidate.manifest_sha256, a.inputVersion, JSON.stringify(a.gate), a.acceptedRiskIds, a.comment, a.userId],
    )
  ).rows[0]!.id;
  await setCandidateStatus(db, a.candidate.id, 'approved');
  return id;
};

export const revokeApproval = async (db: Queryable, approvalId: string, userId: string, reason: string): Promise<void> => {
  await db.query(
    `UPDATE approval SET status = 'revoked', revoked_by = $2, revoke_reason = $3, ended_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'active'`,
    [approvalId, userId, reason],
  );
};

export const insertCandidateReturn = async (db: Queryable, r: { candidate: IReleaseCandidateRow; reason: string; holdId: string | null; userId: string }): Promise<void> => {
  await db.query('INSERT INTO candidate_return (candidate_id, tender_id, reason, hold_id, returned_by) VALUES ($1, $2, $3, $4, $5)', [
    r.candidate.id,
    r.candidate.tender_id,
    r.reason,
    r.holdId,
    r.userId,
  ]);
  await setCandidateStatus(db, r.candidate.id, 'returned');
};

export const insertRelease = async (
  db: Queryable,
  r: {
    id: string;
    candidate: IReleaseCandidateRow;
    approvalId: string;
    inputVersion: number;
    manifest: { blobSha256: string; sha256: string };
    gate: object;
    userId: string;
    releasedAt: Date;
  },
): Promise<void> => {
  await db.query(
    `INSERT INTO release (id, candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate,
                          released_by, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      r.id, r.candidate.id, r.approvalId, r.candidate.tender_id, r.candidate.stage_id, r.candidate.mode, r.inputVersion, r.candidate.manifest_sha256, r.manifest.blobSha256,
      r.manifest.sha256, JSON.stringify(r.gate), r.userId, r.releasedAt,
    ],
  );
  await setCandidateStatus(db, r.candidate.id, 'released');
};

// Решение по удержанию: решение input_event_disposition (событий барьера не порождает) и перевод удержания.
export const resolveHold = async (
  db: Queryable,
  h: IHoldRow,
  r: { resolution: 'not_applicable' | 'requires_new_candidate'; reason: string; userId: string },
): Promise<string> => {
  const decisionId = (
    await db.query<{ id: string }>(
      `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
       VALUES ($1, $2, 'stage_input_event', $3, 'input_event_disposition', $4, $5, $6) RETURNING id`,
      [h.tender_id, h.stage_id, h.input_event_id, r.resolution === 'not_applicable' ? 'не влияет' : 'влияет', r.reason, r.userId],
    )
  ).rows[0]!.id;
  await db.query(
    `UPDATE readiness_hold SET status = $2, decision_id = $3, resolved_by = $4, resolved_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'open'`,
    [h.id, r.resolution === 'not_applicable' ? 'resolved_not_applicable' : 'resolved_requires_new_candidate', decisionId, r.userId],
  );
  return decisionId;
};

// Готовность выпуска к отправке (§4.4; этап 15 вызывает то же): «влияет» — исключён навсегда; непокрытые события без
// «не влияет» — удержан; несвежий канал поступления — нет; иначе готов. Тестовый выпуск не отправляется никогда
// (`sendable: false`), но удержания показываются и у него — путь проверяется тестовым режимом (D-033 В-13-2).
export type SendReadiness = 'excluded' | 'held' | 'intake_not_current' | 'ready';

export const releaseSendReadiness = async (
  db: Queryable,
  r: IReleaseRow,
): Promise<{ state: SendReadiness; sendable: boolean; testRelease: boolean; events: { seq: number; type: string }[] }> => {
  const events = (
    await db.query<{ seq: number; event_type: string; hold_status: string | null }>(
      `SELECT e.seq, e.event_type, h.status AS hold_status FROM candidate_uncovered_events($1) u(id) JOIN stage_input_event e ON e.id = u.id
         LEFT JOIN readiness_hold h ON h.candidate_id = $1 AND h.input_event_id = e.id ORDER BY e.seq`,
      [r.candidate_id],
    )
  ).rows;
  const list = events.map((e) => ({ seq: Number(e.seq), type: e.event_type }));
  let state: SendReadiness = 'ready';
  if (events.some((e) => e.hold_status === 'resolved_requires_new_candidate')) state = 'excluded';
  else if (events.length > 0) state = 'held';
  else {
    const stale = await db.query(
      `SELECT 1 FROM intake_channel WHERE tender_id = $1 AND active AND (last_successful_scan_at IS NULL OR last_successful_scan_at < now() - freshness_window) LIMIT 1`,
      [r.tender_id],
    );
    if (stale.rowCount) state = 'intake_not_current';
  }
  return { state, sendable: r.mode === 'production' && state === 'ready', testRelease: r.mode === 'test', events: list };
};
