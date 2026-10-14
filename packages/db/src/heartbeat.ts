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

// Штатная остановка: своя строка перестаёт быть свежей сразу, иначе /ready ещё workerStaleSeconds
// показывал бы готовность по экземпляру, которого уже нет (этап 17, S17-06). Строка не удаляется.
export const retireHeartbeat = async (db: Queryable, processId: string): Promise<void> => {
  await db.query('UPDATE process_heartbeat SET last_seen_at = to_timestamp(0) WHERE process_id = $1', [processId]);
};
