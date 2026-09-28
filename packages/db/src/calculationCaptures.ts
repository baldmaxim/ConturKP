// Расчёт TenderHub (этап 06; data-model §4.2, §4.5; state-machines §6; ADR-007 §5–8): связь этапа с
// тендером TenderHub, выгрузки, статус интеграции и выгрузка по сроку. Внешние вызовы делает worker вне
// транзакции; здесь — короткие транзакции записи под арендой задания (state-machines §1).
import { randomUUID } from 'node:crypto';
import { contentTenderIds, type IAccessContext } from './access.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';

export class CalculationDomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- Источник расчёта этапа

export interface ICalculationSourceRow {
  id: string;
  stage_id: string;
  tender_id: string;
  system: 'tenderhub';
  external_tender_id: string;
  external_version: number | null;
  role: 'primary' | 'reference';
  created_by: string;
  created_at: Date;
  updated_at: Date;
  row_version: number;
}

export const listCalculationSources = async (db: Queryable, stageId: string): Promise<ICalculationSourceRow[]> => {
  const r = await db.query<ICalculationSourceRow>(
    `SELECT * FROM stage_calculation_source WHERE stage_id = $1 ORDER BY role = 'primary' DESC, updated_at DESC, id`,
    [stageId],
  );
  return r.rows;
};

export const primaryCalculationSource = async (db: Queryable, stageId: string): Promise<ICalculationSourceRow | null> => {
  const r = await db.query<ICalculationSourceRow>("SELECT * FROM stage_calculation_source WHERE stage_id = $1 AND role = 'primary'", [stageId]);
  return r.rows[0] ?? null;
};

// Назначает основную связь этапа (Q-03). Прежняя основная связь с другим тендером TenderHub остаётся
// справочной: история выгрузок и ревизий по ней сохраняется. Вызывается под блокировкой этапа.
export const setPrimaryCalculationSource = async (
  db: Queryable,
  s: { stageId: string; tenderId: string; externalTenderId: string; externalVersion: number | null; userId: string },
): Promise<{ changed: boolean }> => {
  const current = await primaryCalculationSource(db, s.stageId);
  const target = s.externalTenderId.toLowerCase();
  if (current && current.external_tender_id === target) {
    if (current.external_version === s.externalVersion) return { changed: false };
    await db.query(
      'UPDATE stage_calculation_source SET external_version = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1',
      [current.id, s.externalVersion],
    );
    return { changed: true };
  }
  if (current) {
    await db.query(
      "UPDATE stage_calculation_source SET role = 'reference', updated_at = now(), row_version = row_version + 1 WHERE id = $1",
      [current.id],
    );
  }
  await db.query(
    `INSERT INTO stage_calculation_source (stage_id, tender_id, system, external_tender_id, external_version, role, created_by)
     VALUES ($1, $2, 'tenderhub', $3, $4, 'primary', $5)
     ON CONFLICT (stage_id, system, external_tender_id) DO UPDATE
       SET role = 'primary', external_version = EXCLUDED.external_version, updated_at = now(),
           row_version = stage_calculation_source.row_version + 1`,
    [s.stageId, s.tenderId, target, s.externalVersion, s.userId],
  );
  return { changed: true };
};

// ---------------------------------------------------------------- Выгрузка

export type CaptureStatus = 'capturing' | 'complete' | 'inconsistent' | 'failed';

export interface ICaptureRow {
  id: string;
  stage_id: string;
  tender_id: string;
  source_id: string;
  system: 'tenderhub';
  external_tender_id: string;
  capture_kind: 'portal_capture' | 'tenderhub_revision';
  transport: 'api';
  trigger: 'manual' | 'deadline';
  deadline_basis: Date | null;
  status: CaptureStatus;
  requested_by: string | null;
  attempts: Record<string, unknown>[];
  consistency: Record<string, unknown> | null;
  source_observed: Record<string, unknown> | null;
  raw_bundle_sha256: string | null;
  contract_version: string | null;
  content_id: string | null;
  revision_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  job_id: string | null;
  created_at: Date;
  finished_at: Date | null;
  row_version: number;
}

export const createCapture = async (
  db: Queryable,
  c: {
    id: string;
    stageId: string;
    tenderId: string;
    sourceId: string;
    externalTenderId: string;
    trigger: 'manual' | 'deadline';
    requestedBy: string | null;
    deadlineBasis: Date | null;
    jobId: string;
  },
): Promise<ICaptureRow> => {
  const r = await db.query<ICaptureRow>(
    `INSERT INTO calculation_capture (id, stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport,
                                      trigger, deadline_basis, requested_by, job_id)
     VALUES ($1, $2, $3, $4, 'tenderhub', $5, 'portal_capture', 'api', $6, $7, $8, $9) RETURNING *`,
    [c.id, c.stageId, c.tenderId, c.sourceId, c.externalTenderId, c.trigger, c.deadlineBasis, c.requestedBy, c.jobId],
  );
  return r.rows[0]!;
};

// Выгрузка и её задание — в транзакции вызывающего (state-machines §1): запрос пользователя или срок
// подачи. Одна незавершённая выгрузка на (этап, тендер TenderHub) — уникальный индекс.
export const requestCapture = async (
  db: Queryable,
  r: {
    stageId: string;
    tenderId: string;
    source: Pick<ICalculationSourceRow, 'id' | 'external_tender_id'>;
    trigger: 'manual' | 'deadline';
    requestedBy: string | null;
    deadlineBasis: Date | null;
    maxAttempts: number;
  },
): Promise<ICaptureRow> => {
  const id = randomUUID();
  const window = r.trigger === 'deadline' ? `deadline:${r.deadlineBasis!.toISOString()}` : `manual:${id}`;
  const job = await enqueueJob(db, {
    kind: 'calculation.capture',
    dedupeKey: `capture:${r.stageId}:${r.source.external_tender_id}:${window}`,
    payload: { captureId: id },
    resourceClass: 'network',
    maxAttempts: r.maxAttempts,
    tenderId: r.tenderId,
  });
  return createCapture(db, {
    id,
    stageId: r.stageId,
    tenderId: r.tenderId,
    sourceId: r.source.id,
    externalTenderId: r.source.external_tender_id,
    trigger: r.trigger,
    requestedBy: r.requestedBy,
    deadlineBasis: r.deadlineBasis,
    jobId: job.id,
  });
};

export const getCapture = async (db: Queryable, id: string, lock = false): Promise<ICaptureRow | null> => {
  const r = await db.query<ICaptureRow>(`SELECT * FROM calculation_capture WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
};

export const getCaptureInScope = async (db: Queryable, ctx: IAccessContext, id: string): Promise<ICaptureRow | null> => {
  const r = await db.query<ICaptureRow>('SELECT * FROM calculation_capture WHERE id = $1 AND tender_id = ANY($2::uuid[])', [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const listCaptures = async (db: Queryable, stageId: string, limit: number): Promise<ICaptureRow[]> => {
  const r = await db.query<ICaptureRow>('SELECT * FROM calculation_capture WHERE stage_id = $1 ORDER BY created_at DESC, id LIMIT $2', [stageId, limit]);
  return r.rows;
};

export const activeCapture = async (db: Queryable, stageId: string, externalTenderId: string): Promise<ICaptureRow | null> => {
  const r = await db.query<ICaptureRow>(
    "SELECT * FROM calculation_capture WHERE stage_id = $1 AND external_tender_id = $2 AND status = 'capturing'",
    [stageId, externalTenderId],
  );
  return r.rows[0] ?? null;
};

// Попытка дописывается в журнал; прежние записи журнала не меняются (триггер).
export const appendCaptureAttempt = async (db: Queryable, captureId: string, attempt: Record<string, unknown>): Promise<boolean> => {
  const r = await db.query(
    `UPDATE calculation_capture SET attempts = attempts || jsonb_build_array($2::jsonb), row_version = row_version + 1
      WHERE id = $1 AND status = 'capturing'`,
    [captureId, JSON.stringify(attempt)],
  );
  return (r.rowCount ?? 0) > 0;
};

// Терминальный отказ выгрузки: inconsistent — источник менялся во время чтения во всех попытках;
// failed — ошибка доступа, сети, контракта или отмена. Ревизия не создаётся.
export const finishCaptureWithFailure = async (
  db: Queryable,
  captureId: string,
  f: { status: 'failed' | 'inconsistent'; code: string; detail: string; attempt?: Record<string, unknown> },
): Promise<boolean> => {
  const r = await db.query(
    `UPDATE calculation_capture
        SET status = $2, failure_code = $3, failure_detail = $4, finished_at = now(), row_version = row_version + 1,
            attempts = CASE WHEN $5::jsonb IS NULL THEN attempts ELSE attempts || jsonb_build_array($5::jsonb) END
      WHERE id = $1 AND status = 'capturing'`,
    [captureId, f.status, f.code.slice(0, 60), f.detail.slice(0, 500), f.attempt ? JSON.stringify(f.attempt) : null],
  );
  return (r.rowCount ?? 0) > 0;
};

// ---------------------------------------------------------------- Статус интеграции

export const TENDERHUB_READER_KEY = { system: 'tenderhub', component: 'TenderHubReader' } as const;

// Итог выгрузки пишет только worker (ADR-007). Уровень доказательства — VERIFIED_FIXTURE: успешная
// выгрузка сама VERIFIED_LIVE не даёт — только разрешённый live-smoke с артефактом (state-machines §19).
export const recordTenderHubStatus = async (db: Queryable, s: { ok: boolean; errorCode: string | null; details: Record<string, unknown> }): Promise<void> => {
  await db.query(
    `INSERT INTO integration_status (system, component, status, last_checked_at, last_success_at, last_error_code, details, updated_at)
     VALUES ($1, $2, 'VERIFIED_FIXTURE', now(), CASE WHEN $3 THEN now() END, $4, $5::jsonb, now())
     ON CONFLICT (system, component) DO UPDATE SET
       last_checked_at = now(),
       last_success_at = CASE WHEN $3 THEN now() ELSE integration_status.last_success_at END,
       last_error_code = $4,
       details = $5::jsonb,
       updated_at = now()`,
    [TENDERHUB_READER_KEY.system, TENDERHUB_READER_KEY.component, s.ok, s.ok ? null : s.errorCode, JSON.stringify(s.details)],
  );
};

export interface IIntegrationStatusRow {
  component: string;
  status: string;
  evidence_ref: string | null;
  verified_at: Date | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error_code: string | null;
  details: Record<string, unknown>;
}

export const tenderHubStatus = async (db: Queryable): Promise<IIntegrationStatusRow[]> => {
  const r = await db.query<IIntegrationStatusRow>(
    "SELECT component, status, evidence_ref, verified_at, last_checked_at, last_success_at, last_error_code, details FROM integration_status WHERE system = 'tenderhub' ORDER BY component",
  );
  return r.rows;
};

// ---------------------------------------------------------------- Выгрузка по сроку (ADR-007 §7)

// Срок подачи из TenderHub — сигнал для выгрузки, а не закрытие: ревизия остаётся provisional.
// Срок известен после первой выгрузки (brief отдаёт submission_deadline); выгрузка по нему ставится
// один раз, если после срока выгрузок ещё не было.
export const dueDeadlineCaptures = async (
  db: Queryable,
): Promise<{ source_id: string; stage_id: string; tender_id: string; external_tender_id: string; deadline: Date }[]> => {
  const r = await db.query<{ source_id: string; stage_id: string; tender_id: string; external_tender_id: string; deadline: Date }>(
    `SELECT s.id AS source_id, s.stage_id, s.tender_id, s.external_tender_id, d.deadline
       FROM stage_calculation_source s
       JOIN tender_stage ts ON ts.id = s.stage_id AND ts.status = 'active'
       JOIN LATERAL (
         SELECT (c.source_observed ->> 'submissionDeadline')::timestamptz AS deadline
           FROM calculation_capture c
          WHERE c.source_id = s.id AND c.status = 'complete' AND c.source_observed ->> 'submissionDeadline' IS NOT NULL
          ORDER BY c.finished_at DESC LIMIT 1) d ON true
      WHERE s.role = 'primary' AND d.deadline <= now()
        AND NOT EXISTS (SELECT 1 FROM calculation_capture c2 WHERE c2.source_id = s.id AND c2.created_at >= d.deadline)
        AND NOT EXISTS (SELECT 1 FROM calculation_capture c3 WHERE c3.stage_id = s.stage_id AND c3.external_tender_id = s.external_tender_id AND c3.status = 'capturing')`,
  );
  return r.rows;
};
