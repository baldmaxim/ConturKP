// Heartbeat процессов для /ready (ADR-011 §4).
import type { Queryable } from './pool.ts';

export const beat = async (
  db: Queryable,
  p: { processId: string; kind: 'worker'; pid: number; startedAt: Date },
): Promise<void> => {
  await db.query(
    `INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (process_id) DO UPDATE SET last_seen_at = now(), pid = EXCLUDED.pid`,
    [p.processId, p.kind, p.pid, p.startedAt],
  );
};

export const freshWorkerCount = async (db: Queryable, staleSeconds: number): Promise<number> => {
  const r = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM process_heartbeat
      WHERE kind = 'worker' AND last_seen_at > now() - make_interval(secs => $1)`,
    [staleSeconds],
  );
  return r.rows[0]?.n ?? 0;
};
