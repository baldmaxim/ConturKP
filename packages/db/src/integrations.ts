// Статусы интеграций и состояние эксплуатации (этап 17, проект §7.4 и §11). Без адресов, ключей и данных тендеров.
import type { Queryable } from './pool.ts';

export interface IIntegrationRow {
  system: string;
  component: string;
  status: string;
  evidence_ref: string | null;
  verified_at: Date | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error_code: string | null;
}

export const listIntegrationStatuses = async (db: Queryable): Promise<IIntegrationRow[]> =>
  (
    await db.query<IIntegrationRow>(
      'SELECT system, component, status, evidence_ref, verified_at, last_checked_at, last_success_at, last_error_code FROM integration_status ORDER BY system, component',
    )
  ).rows;

export const CHAT_MODEL_STATUS_KEY = { system: 'model', component: 'ModelGateway' } as const;

// Результат вызова генеративной модели (S17-12): строка ('model', 'ModelGateway') с этапа 08 в работе не менялась.
// Уровень проверки не повышается (VERIFIED_LIVE ставит только живая проверка), прежние сведения details сохраняются.
export const recordChatModelStatus = async (db: Queryable, s: { ok: boolean; errorCode: string | null; details: Record<string, unknown> }): Promise<void> => {
  await db.query(
    `INSERT INTO integration_status (system, component, status, last_checked_at, last_success_at, last_error_code, details, updated_at)
     VALUES ($1, $2, 'VERIFIED_FIXTURE', now(), CASE WHEN $3 THEN now() END, $4, $5::jsonb, now())
     ON CONFLICT (system, component) DO UPDATE SET
       last_checked_at = now(),
       last_success_at = CASE WHEN $3 THEN now() ELSE integration_status.last_success_at END,
       last_error_code = $4,
       details = integration_status.details || $5::jsonb,
       updated_at = now()`,
    [CHAT_MODEL_STATUS_KEY.system, CHAT_MODEL_STATUS_KEY.component, s.ok, s.ok ? null : s.errorCode, JSON.stringify(s.details)],
  );
};

// Живая проверка на установке (state-machines §19): VERIFIED_LIVE только со ссылкой на журнал и временем проверки.
export const recordLiveVerification = async (
  db: Queryable,
  s: { system: string; component: string; evidenceRef: string; verifiedAt: Date; details: Record<string, unknown> },
): Promise<void> => {
  await db.query(
    `INSERT INTO integration_status (system, component, status, evidence_ref, verified_at, last_checked_at, last_success_at, last_error_code, details, updated_at)
     VALUES ($1, $2, 'VERIFIED_LIVE', $3, $4, $4, $4, NULL, $5::jsonb, now())
     ON CONFLICT (system, component) DO UPDATE SET
       status = 'VERIFIED_LIVE', evidence_ref = $3, verified_at = $4, last_checked_at = $4, last_success_at = $4,
       last_error_code = NULL, details = integration_status.details || $5::jsonb, updated_at = now()`,
    [s.system, s.component, s.evidenceRef, s.verifiedAt, JSON.stringify(s.details)],
  );
};

export interface IOperationsSnapshot {
  schema: { version: number; migrations: number };
  processes: Array<{ kind: string; pid: number; startedAt: Date; lastSeenAt: Date }>;
  queue: Array<{ kind: string; status: string; count: number }>;
  oldestQueuedSeconds: number | null;
  overdueRunning: number;
  failed24h: number;
  gpu: { holderKind: string | null; lockedUntil: Date | null };
  blobs: { count: number; bytes: number };
}

export const operationsSnapshot = async (db: Queryable): Promise<IOperationsSnapshot> => {
  const schema = await db.query<{ v: number | null; n: number }>('SELECT max(version) AS v, count(*)::int AS n FROM schema_migration');
  const processes = await db.query<{ kind: string; pid: number; started_at: Date; last_seen_at: Date }>(
    `SELECT kind, pid, started_at, last_seen_at FROM process_heartbeat
      WHERE last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC LIMIT 20`,
  );
  const queue = await db.query<{ kind: string; status: string; n: number }>(
    `SELECT kind, status, count(*)::int AS n FROM job
      WHERE status IN ('queued', 'running') OR (status = 'failed' AND finished_at > now() - interval '24 hours')
      GROUP BY kind, status ORDER BY kind, status`,
  );
  const stats = await db.query<{ oldest: number | null; overdue: number; failed: number }>(
    `SELECT (SELECT extract(epoch FROM now() - min(run_after))::int FROM job WHERE status = 'queued' AND run_after <= now()) AS oldest,
            (SELECT count(*)::int FROM job WHERE status = 'running' AND locked_until < now()) AS overdue,
            (SELECT count(*)::int FROM job WHERE status = 'failed' AND finished_at > now() - interval '24 hours') AS failed`,
  );
  const gpu = await db.query<{ kind: string | null; locked_until: Date | null }>(
    `SELECT j.kind, s.locked_until FROM resource_slot s LEFT JOIN job j ON j.id = s.holder_job_id
      WHERE s.slot_key = 'gpu' AND s.holder_job_id IS NOT NULL AND s.locked_until > now()`,
  );
  const blobs = await db.query<{ n: number; bytes: string }>('SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::text AS bytes FROM blob');
  return {
    schema: { version: schema.rows[0]!.v ?? 0, migrations: schema.rows[0]!.n },
    processes: processes.rows.map((p) => ({ kind: p.kind, pid: p.pid, startedAt: p.started_at, lastSeenAt: p.last_seen_at })),
    queue: queue.rows.map((q) => ({ kind: q.kind, status: q.status, count: q.n })),
    oldestQueuedSeconds: stats.rows[0]!.oldest,
    overdueRunning: stats.rows[0]!.overdue,
    failed24h: stats.rows[0]!.failed,
    gpu: { holderKind: gpu.rows[0]?.kind ?? null, lockedUntil: gpu.rows[0]?.locked_until ?? null },
    blobs: { count: blobs.rows[0]!.n, bytes: Number(blobs.rows[0]!.bytes) },
  };
};
