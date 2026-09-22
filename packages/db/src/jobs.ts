// Долговечная очередь заданий (ADR-004, state-machines §2). Протокол аренды (R01-06):
// каждый захват выдаёт новый lease_token; heartbeat, успех, ошибка, подтверждение отмены
// и доменный результат — условные записи по токену. 0 строк — аренда потеряна.
import type pg from 'pg';
import { inTransaction, type Queryable } from './pool.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ResourceClass = 'default' | 'network' | 'gpu';

export interface IJobRow {
  id: string;
  kind: string;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  resource_class: ResourceClass;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  locked_by: string | null;
  locked_until: Date | null;
  cancel_requested: boolean;
  last_error_code: string | null;
  last_error_message: string | null;
  tender_id: string | null;
  run_after: Date;
  created_at: Date;
  finished_at: Date | null;
}

export interface IEnqueueInput {
  kind: string;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
  resourceClass?: ResourceClass;
  priority?: number;
  maxAttempts?: number;
  tenderId?: string | null;
  runAfterMs?: number;
}

// Постановка в транзакции доменной команды. При активном задании с тем же dedupe_key новое не создаётся.
export const enqueueJob = async (db: Queryable, j: IEnqueueInput): Promise<{ id: string; created: boolean }> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job (kind, dedupe_key, payload, resource_class, priority, max_attempts, tender_id, run_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8::double precision / 1000))
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      j.kind,
      j.dedupeKey ?? null,
      JSON.stringify(j.payload ?? {}),
      j.resourceClass ?? 'default',
      j.priority ?? 0,
      j.maxAttempts ?? 5,
      j.tenderId ?? null,
      j.runAfterMs ?? 0,
    ],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: true };
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM job WHERE dedupe_key = $1 AND status IN ('queued', 'running')",
    [j.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
};

export interface IClaimOptions {
  workerId: string;
  leaseMs: number;
  gpuGraceMs: number;
  kinds?: string[];
}

// Захват: FOR UPDATE SKIP LOCKED; для gpu — слот resource_slot тем же токеном, но только
// после locked_until прежнего держателя + защитный интервал.
export const claimJob = async (pool: pg.Pool, o: IClaimOptions): Promise<IJobRow | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slot = await client.query<{ free: boolean }>(
      `SELECT (holder_job_id IS NULL OR locked_until IS NULL
               OR locked_until + make_interval(secs => $1::double precision / 1000) < now()) AS free
         FROM resource_slot WHERE slot_key = 'gpu' FOR UPDATE`,
      [o.gpuGraceMs],
    );
    const gpuFree = slot.rows[0]?.free ?? false;
    const pick = await client.query<{ id: string; resource_class: ResourceClass; cancel_requested: boolean }>(
      `SELECT id, resource_class, cancel_requested FROM job
        WHERE status = 'queued' AND run_after <= now()
          AND ($1::boolean OR resource_class <> 'gpu')
          AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
        ORDER BY priority DESC, run_after, created_at
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [gpuFree, o.kinds ?? null],
    );
    const row = pick.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    // Отмена, запрошенная до захвата или при прежнем владельце, завершается новым владельцем.
    // Задание захватывается штатно и здесь не терминализуется: доменный объект (партия импорта,
    // прогон распознавания) знает о себе только обработчик, а пакет БД — нет. Worker видит флаг
    // сразу после захвата и проводит отмену через onCancel одной транзакцией (R04-02).
    const r = await client.query<IJobRow>(
      `UPDATE job SET status = 'running', lease_token = gen_random_uuid(), locked_by = $2,
              locked_until = now() + make_interval(secs => $3::double precision / 1000),
              attempts = attempts + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [row.id, o.workerId, o.leaseMs],
    );
    const job = r.rows[0]!;
    if (row.resource_class === 'gpu') {
      await client.query(
        `UPDATE resource_slot SET holder_job_id = $1, lease_token = $2, locked_until = $3 WHERE slot_key = 'gpu'`,
        [job.id, job.lease_token, job.locked_until],
      );
    }
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export interface IHeartbeat {
  ok: boolean;
  cancelRequested: boolean;
}

// ЕДИНЫЙ ПОРЯДОК БЛОКИРОВОК GPU: resource_slot → job (ADR-004, R03-10).
// Любой переход, затрагивающий обе строки, берёт сначала слот, затем задание — иначе
// heartbeat и доменная транзакция образуют цикл ожидания.
//
// Условие владения заданием: для класса gpu аренда действительна, только пока слот
// принадлежит этому же заданию и тому же токену (R03-04).
const OWNS_JOB = `j.id = $1 AND j.lease_token = $2 AND j.status = 'running'
    AND (j.resource_class <> 'gpu'
         OR EXISTS (SELECT 1 FROM resource_slot s WHERE s.slot_key = 'gpu' AND s.holder_job_id = j.id AND s.lease_token = j.lease_token))`;

const isGpuJob = async (db: Queryable, id: string): Promise<boolean> => {
  const r = await db.query<{ resource_class: ResourceClass }>('SELECT resource_class FROM job WHERE id = $1', [id]);
  return r.rows[0]?.resource_class === 'gpu';
};

// Продление аренды — короткая транзакция в порядке слот → задание: обе аренды продлеваются
// вместе либо не меняется ничего (R03-11). Потеря аренды задания не продлевает слот, и наоборот.
export const heartbeatJob = async (pool: pg.Pool, id: string, token: string, leaseMs: number): Promise<IHeartbeat> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gpu = await isGpuJob(client, id);
    if (gpu) {
      const slot = await client.query(
        "SELECT 1 FROM resource_slot WHERE slot_key = 'gpu' AND holder_job_id = $1 AND lease_token = $2 FOR UPDATE",
        [id, token],
      );
      if ((slot.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { ok: false, cancelRequested: false };
      }
    }
    const job = await client.query<{ cancel_requested: boolean }>(
      "SELECT cancel_requested FROM job WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR UPDATE",
      [id, token],
    );
    if ((job.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return { ok: false, cancelRequested: false };
    }
    const until = await client.query<{ locked_until: Date }>(
      'UPDATE job SET locked_until = now() + make_interval(secs => $2::double precision / 1000), updated_at = now() WHERE id = $1 RETURNING locked_until',
      [id, leaseMs],
    );
    if (gpu) {
      await client.query("UPDATE resource_slot SET locked_until = $3 WHERE slot_key = 'gpu' AND holder_job_id = $1 AND lease_token = $2", [
        id,
        token,
        until.rows[0]!.locked_until,
      ]);
    }
    await client.query('COMMIT');
    return { ok: true, cancelRequested: job.rows[0]!.cancel_requested };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

// Подтверждение владения в порядке resource_slot → job: сначала блокируется и проверяется слот
// (для gpu), затем задание. Ни одна запись не выполняется, пока обе проверки не прошли (R03-13).
interface IOwnership {
  ok: boolean;
  gpu: boolean;
}

const lockOwnership = async (db: Queryable, id: string, token: string): Promise<IOwnership> => {
  const gpu = await isGpuJob(db, id);
  if (gpu) {
    const slot = await db.query(
      "SELECT 1 FROM resource_slot WHERE slot_key = 'gpu' AND holder_job_id = $1 AND lease_token = $2 FOR UPDATE",
      [id, token],
    );
    if ((slot.rowCount ?? 0) === 0) return { ok: false, gpu };
  }
  const job = await db.query("SELECT 1 FROM job WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR UPDATE", [id, token]);
  return { ok: (job.rowCount ?? 0) > 0, gpu };
};

// Блокировка задания перед доменной записью (тот же порядок и те же проверки).
export const lockOwnedJob = async (db: Queryable, id: string, token: string): Promise<boolean> =>
  (await lockOwnership(db, id, token)).ok;

// Освобождение слота — только после подтверждения владения заданием (R03-13).
const releaseSlot = async (db: Queryable, id: string, token: string): Promise<void> => {
  await db.query(
    "UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu' AND holder_job_id = $1 AND lease_token = $2",
    [id, token],
  );
};

const finish = async (db: Queryable, id: string, token: string, status: 'succeeded' | 'failed' | 'cancelled', code: string | null, message: string | null): Promise<boolean> =>
  inTransaction(db, async (client) => {
    const own = await lockOwnership(client, id, token);
    if (!own.ok) return false;
    if (own.gpu) await releaseSlot(client, id, token);
    await client.query(
      `UPDATE job SET status = $3, lease_token = NULL, locked_until = NULL, finished_at = now(), updated_at = now(),
              last_error_code = coalesce($4, last_error_code), last_error_message = coalesce($5, last_error_message)
        WHERE id = $1 AND lease_token = $2`,
      [id, token, status, code, message],
    );
    return true;
  });

export const succeedJob = (db: Queryable, id: string, token: string): Promise<boolean> => finish(db, id, token, 'succeeded', null, null);

export const confirmCancel = (db: Queryable, id: string, token: string): Promise<boolean> => finish(db, id, token, 'cancelled', null, null);

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

export const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

// Ошибка: повторяемая — назад в очередь с экспоненциальной задержкой, пока есть попытки;
// иначе failed. Текст ошибки — без секретов (вызывающий передаёт код и безопасное сообщение).
export const failJob = async (
  db: Queryable,
  job: Pick<IJobRow, 'id' | 'attempts' | 'max_attempts'>,
  token: string,
  e: { retryable: boolean; code: string; message: string },
): Promise<{ ok: boolean; status: JobStatus }> => {
  if (e.retryable && job.attempts < job.max_attempts) {
    const ok = await requeueJob(db, job, token, { code: e.code, message: e.message });
    return ok ? { ok: true, status: 'queued' } : { ok: false, status: 'running' };
  }
  const ok = await finish(db, job.id, token, 'failed', e.code, e.message.slice(0, 500));
  return { ok, status: 'failed' };
};

// Возврат задания в очередь без объявления результата: используется, когда доменную фиксацию
// терминальной ошибки не удалось записать (R03-05). Правило «обе записи или ни одной»:
// объявлять задание failed без доменного отказа нельзя.
export const requeueJob = async (
  db: Queryable,
  job: Pick<IJobRow, 'id' | 'attempts'>,
  token: string,
  e: { code: string; message: string },
): Promise<boolean> =>
  inTransaction(db, async (client) => {
    const own = await lockOwnership(client, job.id, token);
    if (!own.ok) return false;
    if (own.gpu) await releaseSlot(client, job.id, token);
    await client.query(
      `UPDATE job SET status = 'queued', lease_token = NULL, locked_by = NULL, locked_until = NULL,
              run_after = now() + make_interval(secs => $3::double precision / 1000),
              last_error_code = $4, last_error_message = $5, updated_at = now()
        WHERE id = $1 AND lease_token = $2`,
      [job.id, token, backoffMs(job.attempts), e.code, e.message.slice(0, 500)],
    );
    return true;
  });

// Recovery-проход: задания с истёкшей арендой возвращаются в очередь, токен обнуляется (A15).
// Слот GPU не освобождается: новый захват слота возможен только после защитного интервала.
export const recoverExpiredJobs = async (db: Queryable): Promise<string[]> => {
  const r = await db.query<{ id: string }>(
    `UPDATE job SET status = 'queued', lease_token = NULL, locked_by = NULL, locked_until = NULL, updated_at = now(),
            last_error_code = coalesce(last_error_code, 'lease_expired')
      WHERE status = 'running' AND locked_until < now()
      RETURNING id`,
  );
  return r.rows.map((x) => x.id);
};

// Отмена: queued — сразу; running — флаг, подтверждает действующий владелец или следующий захват.
export const requestCancel = async (db: Queryable, id: string): Promise<JobStatus | null> => {
  const r = await db.query<{ status: JobStatus }>(
    `UPDATE job SET
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
        cancel_requested = CASE WHEN status = 'running' THEN true ELSE cancel_requested END,
        updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING status`,
    [id],
  );
  return r.rows[0]?.status ?? null;
};

export const getJob = async (db: Queryable, id: string): Promise<IJobRow | null> => {
  const r = await db.query<IJobRow>('SELECT * FROM job WHERE id = $1', [id]);
  return r.rows[0] ?? null;
};
