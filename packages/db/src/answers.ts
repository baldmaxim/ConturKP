// Диалоги и прогоны ответа (этап 08a, D-019, D-027): данные в PostgreSQL, вторая линия — охранники миграции 0022.
// Вопрос, прогон поиска, прогон ответа и задание — одной транзакцией; пакет, утверждения, сообщение ответа и итог —
// одной транзакцией завершения под арендой задания. Непроверенный текст модели сюда не передаётся.
import type { AnswerStatus, IncompleteReason, IPacketCandidate } from '@kontur/core';
import type { IAccessContext } from './access.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { readableFragments } from './requirementAccess.ts';

export const ANSWER_JOB_KIND = 'answer.generate';
// ADR-004 §7a: ответ ответного ядра — класс gpu, приоритет 90, интерактивная полоса worker.
export const ANSWER_JOB_PRIORITY = 90;

export interface IDialogRow {
  id: string;
  context_kind: 'tender' | 'contract';
  tender_id: string | null;
  contract_id: string | null;
  stage_id: string | null;
  mode: 'working' | 'review' | 'contract';
  evidence_scope_id: string | null;
  title: string;
  created_by: string;
  created_at: Date;
}

export interface IDialogMessageRow {
  id: string;
  dialog_id: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  created_by: string | null;
  answer_run_id: string | null;
  created_at: Date;
}

export interface IAnswerRunRow {
  id: string;
  dialog_id: string;
  seq: number;
  question_message_id: string;
  search_run_id: string;
  requested_by: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  answer_status: AnswerStatus | null;
  incomplete_reason: IncompleteReason | null;
  plan: Record<string, unknown>;
  planner_version: string;
  provider_id: string | null;
  model_id: string | null;
  model_version: string | null;
  prompt_version: string;
  prompt_sha256: string;
  verifier_mode: 'off' | 'same_model';
  verification_level: 'none' | 'hard_checks' | 'model' | null;
  config_sha256: string | null;
  input_sha256: string | null;
  draft_sha256: string | null;
  repairs: number;
  coverage: Record<string, unknown>;
  attempt: number;
  job_id: string | null;
  failure_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
}

export interface IAnswerEvidenceRow {
  run_id: string;
  label: string;
  ordinal: number;
  fragment_id: string;
  origin: string;
  version_note: 'current' | 'superseded' | 'conflict';
  reason: string;
}

export interface IAnswerClaimRow {
  run_id: string;
  claim_no: number;
  kind: string;
  text: string | null;
  labels: string[];
  check_status: string;
  issues: string[];
  verifier_status: string | null;
  final_status: string;
  shown: boolean;
  citations: number[];
}

export const createDialog = async (
  db: Queryable,
  d: { contextKind: 'tender' | 'contract'; tenderId: string | null; contractId: string | null; stageId: string | null; mode: IDialogRow['mode']; evidenceScopeId: string | null; title: string; userId: string },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO dialog (context_kind, tender_id, contract_id, stage_id, mode, evidence_scope_id, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [d.contextKind, d.tenderId, d.contractId, d.stageId, d.mode, d.evidenceScopeId, d.title, d.userId],
  );
  return r.rows[0]!.id;
};

export const getDialog = async (db: Queryable, id: string): Promise<IDialogRow | null> =>
  (await db.query<IDialogRow>('SELECT * FROM dialog WHERE id = $1', [id])).rows[0] ?? null;

// Свои диалоги контекста: чужие не выдаются никому, включая администратора (AD-08a-4).
export const listDialogs = async (db: Queryable, userId: string, f: { tenderId?: string | null; stageId?: string | null; contractId?: string | null }): Promise<IDialogRow[]> =>
  (
    await db.query<IDialogRow>(
      `SELECT * FROM dialog
        WHERE created_by = $1
          AND ($2::uuid IS NULL OR tender_id = $2) AND ($3::uuid IS NULL OR stage_id = $3) AND ($4::uuid IS NULL OR contract_id = $4)
        ORDER BY created_at DESC LIMIT 200`,
      [userId, f.tenderId ?? null, f.stageId ?? null, f.contractId ?? null],
    )
  ).rows;

export const dialogMessages = async (db: Queryable, dialogId: string): Promise<IDialogMessageRow[]> =>
  (await db.query<IDialogMessageRow>('SELECT * FROM dialog_message WHERE dialog_id = $1 ORDER BY seq', [dialogId])).rows;

export const dialogRuns = async (db: Queryable, dialogId: string): Promise<IAnswerRunRow[]> =>
  (await db.query<IAnswerRunRow>('SELECT * FROM answer_run WHERE dialog_id = $1 ORDER BY seq', [dialogId])).rows;

export const getAnswerRun = async (db: Queryable, id: string, lock = false): Promise<IAnswerRunRow | null> =>
  (await db.query<IAnswerRunRow>(`SELECT * FROM answer_run WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;

export const pendingRunOf = async (db: Queryable, dialogId: string): Promise<IAnswerRunRow | null> =>
  (await db.query<IAnswerRunRow>("SELECT * FROM answer_run WHERE dialog_id = $1 AND status IN ('queued', 'running')", [dialogId])).rows[0] ?? null;

// Вопрос: сообщение, прогон ответа (состояние queued) и задание gpu — в транзакции, где уже создан прогон поиска.
export const createQuestion = async (
  db: Queryable,
  q: {
    dialogId: string;
    tenderId: string | null;
    text: string;
    userId: string;
    searchRunId: string;
    plan: Record<string, unknown>;
    plannerVersion: string;
    promptVersion: string;
    promptSha256: string;
    verifierMode: 'off' | 'same_model';
  },
): Promise<{ messageId: string; runId: string; jobId: string }> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('dialog_message'), hashtext($1::text))", [q.dialogId]);
  const seq = (await db.query<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM dialog_message WHERE dialog_id = $1', [q.dialogId])).rows[0]!.n;
  const msg = await db.query<{ id: string }>("INSERT INTO dialog_message (dialog_id, seq, role, text, created_by) VALUES ($1, $2, 'user', $3, $4) RETURNING id", [
    q.dialogId,
    seq,
    q.text,
    q.userId,
  ]);
  const runId = (await db.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const job = await enqueueJob(db, {
    kind: ANSWER_JOB_KIND,
    dedupeKey: `answer:${runId}`,
    payload: { runId },
    resourceClass: 'gpu',
    priority: ANSWER_JOB_PRIORITY,
    maxAttempts: 30,
    tenderId: q.tenderId,
  });
  const runSeq = (await db.query<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM answer_run WHERE dialog_id = $1', [q.dialogId])).rows[0]!.n;
  await db.query(
    `INSERT INTO answer_run (id, dialog_id, seq, question_message_id, search_run_id, requested_by, plan, planner_version, prompt_version, prompt_sha256, verifier_mode, job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [runId, q.dialogId, runSeq, msg.rows[0]!.id, q.searchRunId, q.userId, JSON.stringify(q.plan), q.plannerVersion, q.promptVersion, q.promptSha256, q.verifierMode, job.id],
  );
  return { messageId: msg.rows[0]!.id, runId, jobId: job.id };
};

// Задание захвачено: прогон выполняется (повтор задания — снова running, номер попытки растёт).
export const markAnswerRunning = async (db: Queryable, runId: string): Promise<IAnswerRunRow | null> =>
  (
    await db.query<IAnswerRunRow>(
      `UPDATE answer_run SET status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()), row_version = row_version + 1
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`,
      [runId],
    )
  ).rows[0] ?? null;

export const failAnswerRun = async (db: Queryable, runId: string, code: string): Promise<void> => {
  await db.query(
    `UPDATE answer_run SET status = 'failed', failure_code = $2, started_at = coalesce(started_at, now()), finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [runId, code.slice(0, 60)],
  );
};

export interface IAnswerCompletion {
  answerStatus: AnswerStatus;
  incompleteReason: IncompleteReason | null;
  answerText: string;
  providerId: string | null;
  modelId: string | null;
  modelVersion: string | null;
  verificationLevel: 'none' | 'hard_checks' | 'model';
  inferenceConfig: Record<string, unknown> | null;
  configSha256: string | null;
  inputSha256: string | null;
  draftSha256: string | null;
  repairs: number;
  coverage: Record<string, unknown>;
  evidence: { label: string; ordinal: number; fragmentId: string; origin: string; versionNote: string; reason: string }[];
  claims: { claimNo: number; kind: string; text: string | null; textSha256: string; labels: string[]; checkStatus: string; issues: string[]; verifierStatus: string | null; finalStatus: string; shown: boolean; citations: number[] }[];
}

// Завершение хода: пакет, утверждения, сообщение ответа и итог прогона. Вызывается в транзакции под арендой.
export const completeAnswerRun = async (db: Queryable, run: IAnswerRunRow, c: IAnswerCompletion): Promise<void> => {
  for (const e of c.evidence) {
    await db.query(
      'INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [run.id, e.label, e.ordinal, e.fragmentId, e.origin, e.versionNote, e.reason.slice(0, 200)],
    );
  }
  for (const cl of c.claims) {
    await db.query(
      `INSERT INTO answer_claim (run_id, claim_no, kind, text_sha256, text, labels, check_status, issues, verifier_status, final_status, shown, citations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [run.id, cl.claimNo, cl.kind, cl.textSha256, cl.text, cl.labels, cl.checkStatus, cl.issues, cl.verifierStatus, cl.finalStatus, cl.shown, cl.citations],
    );
  }
  await db.query("SELECT pg_advisory_xact_lock(hashtext('dialog_message'), hashtext($1::text))", [run.dialog_id]);
  const seq = (await db.query<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM dialog_message WHERE dialog_id = $1', [run.dialog_id])).rows[0]!.n;
  await db.query("INSERT INTO dialog_message (dialog_id, seq, role, text, answer_run_id) VALUES ($1, $2, 'assistant', $3, $4)", [run.dialog_id, seq, c.answerText, run.id]);
  await db.query(
    `UPDATE answer_run SET status = 'completed', answer_status = $2, incomplete_reason = $3, provider_id = $4, model_id = $5, model_version = $6,
            verification_level = $7, inference_config = $8, config_sha256 = $9, input_sha256 = $10, draft_sha256 = $11, repairs = $12, coverage = $13,
            finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'running'`,
    [
      run.id,
      c.answerStatus,
      c.incompleteReason,
      c.providerId,
      c.modelId,
      c.modelVersion,
      c.verificationLevel,
      c.inferenceConfig ? JSON.stringify(c.inferenceConfig) : null,
      c.configSha256,
      c.inputSha256,
      c.draftSha256,
      c.repairs,
      JSON.stringify(c.coverage),
    ],
  );
};

export const runEvidence = async (db: Queryable, runIds: readonly string[]): Promise<IAnswerEvidenceRow[]> =>
  runIds.length ? (await db.query<IAnswerEvidenceRow>('SELECT * FROM answer_evidence WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, ordinal', [runIds])).rows : [];

export const runClaims = async (db: Queryable, runIds: readonly string[]): Promise<IAnswerClaimRow[]> =>
  runIds.length
    ? (
        await db.query<IAnswerClaimRow>(
          'SELECT run_id, claim_no, kind, text, labels, check_status, issues, verifier_status, final_status, shown, citations FROM answer_claim WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, claim_no',
          [runIds],
        )
      ).rows
    : [];

// Отметка вместо текста прежнего ответа, процитированное основание которого автор сейчас не читает (R08a-02).
export const HIDDEN_ANSWER_MARK = '(ответ скрыт: нет доступа к его основаниям)';

// Предыдущие ходы диалога (для уточняющего вопроса): вопрос и показанный ответ завершённых прогонов. R08a-02: текст
// ответа — только если автор сейчас читает все его процитированные основания (то же правило, что при чтении ответа,
// `answerRunView`); иначе вместо текста — отметка. Проверка — до любого обращения к модели.
export const previousTurns = async (db: Queryable, access: IAccessContext | null, dialogId: string, beforeSeq: number): Promise<{ question: string; answer: string }[]> => {
  const rows = (
    await db.query<{ id: string; question: string; answer: string; cited: string[] }>(
      `SELECT r.id, q.text AS question, a.text AS answer,
              coalesce((SELECT array_agg(e.fragment_id) FROM answer_evidence e
                         WHERE e.run_id = r.id AND e.label IN (SELECT jsonb_array_elements_text(coalesce(r.coverage -> 'citations', '[]'::jsonb)))), '{}') AS cited
         FROM answer_run r
         JOIN dialog_message q ON q.id = r.question_message_id
         JOIN dialog_message a ON a.answer_run_id = r.id
        WHERE r.dialog_id = $1 AND r.seq < $2 AND r.status = 'completed'
        ORDER BY r.seq`,
      [dialogId, beforeSeq],
    )
  ).rows;
  const readable = access ? await readableFragments(db, access, rows.flatMap((r) => r.cited)) : new Set<string>();
  return rows.map((r) => ({ question: r.question, answer: r.cited.every((f) => readable.has(f)) ? r.answer : HIDDEN_ANSWER_MARK }));
};

interface ICandidateRow {
  id: string;
  text: string;
  origin: string;
  source_unit_id: string;
  tender_id: string | null;
  contract_id: string | null;
  document_id: string | null;
  mail_message_revision_id: string | null;
  transcript_revision_id: string | null;
  qa_item_revision_id: string | null;
}

const CANDIDATE_SELECT = `SELECT f.id, f.text, f.origin, f.source_unit_id, f.tender_id, f.contract_id, dr.document_id, f.mail_message_revision_id,
       f.transcript_revision_id, f.qa_item_revision_id
  FROM evidence_fragment f
  LEFT JOIN document_revision dr ON dr.id = f.document_revision_id`;

const toCandidate = (row: ICandidateRow, rank: number, reason: string): IPacketCandidate => ({
  fragmentId: row.id,
  text: row.text,
  origin: row.origin,
  sourceUnitId: row.source_unit_id,
  documentKey: row.document_id ?? row.mail_message_revision_id ?? row.transcript_revision_id ?? row.qa_item_revision_id ?? row.source_unit_id,
  ownerKey: row.contract_id ? `contract:${row.contract_id}` : `tender:${row.tender_id ?? ''}`,
  rank,
  reason,
});

// Кандидаты пакета — слитые попадания прогона поиска по рангу (фрагменты, которых больше нет в области, не берутся).
export const searchCandidates = async (db: Queryable, searchRunId: string, allowedUnits: readonly string[]): Promise<IPacketCandidate[]> => {
  const hits = await db.query<{ fragment_id: string; rank: number }>("SELECT fragment_id, rank FROM search_run_result WHERE run_id = $1 AND branch = 'fused' ORDER BY rank", [searchRunId]);
  if (hits.rows.length === 0) return [];
  const rows = await db.query<ICandidateRow>(`${CANDIDATE_SELECT} WHERE f.id = ANY($1::uuid[]) AND f.source_unit_id = ANY($2::uuid[])`, [hits.rows.map((h) => h.fragment_id), [...allowedUnits]]);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  return hits.rows.flatMap((h) => {
    const row = byId.get(h.fragment_id);
    return row ? [toCandidate(row, h.rank, `search:${h.rank}`)] : [];
  });
};

// Фрагменты фактов запланированных типов (граф D-018, донор `factsForPlan`) — в пределах области хода, в заданном порядке.
export const fragmentCandidates = async (
  db: Queryable,
  ordered: readonly { fragmentId: string; reason: string }[],
  allowedUnits: readonly string[],
  startRank: number,
): Promise<IPacketCandidate[]> => {
  if (ordered.length === 0) return [];
  const rows = await db.query<ICandidateRow>(`${CANDIDATE_SELECT} WHERE f.id = ANY($1::uuid[]) AND f.source_unit_id = ANY($2::uuid[])`, [ordered.map((o) => o.fragmentId), [...allowedUnits]]);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  return ordered.flatMap((o, i) => {
    const row = byId.get(o.fragmentId);
    return row ? [{ ...toCandidate(row, startRank + i, o.reason), factHit: true }] : [];
  });
};

// Единицы области прогона поиска: каких нет совсем, а какие не распознаны (неполнота области).
export const searchScopeCounts = async (db: Queryable, searchRunId: string): Promise<{ units: number; counts: Record<string, unknown> }> => {
  const r = await db.query<{ units: number; counts: Record<string, unknown> }>(
    'SELECT cardinality(allowed_source_unit_ids) AS units, scope_counts AS counts FROM search_run WHERE id = $1',
    [searchRunId],
  );
  return r.rows[0] ?? { units: 0, counts: {} };
};
