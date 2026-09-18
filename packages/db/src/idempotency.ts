// Идемпотентность команд (ADR-005 §10). Запись делается в транзакции команды;
// параллельные повторы с одним ключом сериализуются транзакционной advisory-блокировкой.
import type { Queryable } from './pool.ts';

export const IDEMPOTENCY_TTL_DAYS = 7;

export interface IStoredResponse {
  requestHash: string;
  status: number;
  body: unknown;
}

export const lockIdempotencyKey = async (db: Queryable, principalId: string, key: string): Promise<void> => {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idem:${principalId}:${key}`]);
};

export const findIdempotent = async (db: Queryable, principalId: string, key: string): Promise<IStoredResponse | null> => {
  const r = await db.query<{ request_hash: string; response_status: number; response_body: unknown }>(
    'SELECT request_hash, response_status, response_body FROM idempotency_record WHERE principal_id = $1 AND key = $2',
    [principalId, key],
  );
  const row = r.rows[0];
  return row ? { requestHash: row.request_hash, status: row.response_status, body: row.response_body } : null;
};

export const saveIdempotent = async (
  db: Queryable,
  principalId: string,
  key: string,
  response: IStoredResponse,
): Promise<void> => {
  await db.query(
    `INSERT INTO idempotency_record (principal_id, key, request_hash, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [principalId, key, response.requestHash, response.status, JSON.stringify(response.body), IDEMPOTENCY_TTL_DAYS],
  );
};
