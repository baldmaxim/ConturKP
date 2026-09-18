// Серверные сессии (ADR-006 §12): в БД только SHA-256 токена сессии и CSRF-токена.
import { createHash } from 'node:crypto';
import type { Queryable } from './pool.ts';

export const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export type RevokeReason = 'logout' | 'password_changed' | 'user_disabled' | 'roles_changed';

export const insertSession = async (
  db: Queryable,
  s: { token: string; csrf: string; userId: string; now: Date; expiresAt: Date },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO session (token_hash, csrf_hash, user_id, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
    [sha256(s.token), sha256(s.csrf), s.userId, s.now, s.expiresAt],
  );
  return r.rows[0]!.id;
};

export interface IActiveSession {
  id: string;
  user_id: string;
  csrf_hash: Buffer;
  last_seen_at: Date;
}

// Действительна: не отозвана, не истёк абсолютный срок и срок неактивности, пользователь активен.
export const findActiveSession = async (
  db: Queryable,
  token: string,
  now: Date,
  idleMinutes: number,
): Promise<IActiveSession | null> => {
  const r = await db.query<IActiveSession>(
    `SELECT s.id, s.user_id, s.csrf_hash, s.last_seen_at
       FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
        AND s.last_seen_at > $2 - make_interval(mins => $3)
        AND u.status = 'active' AND u.kind = 'human'`,
    [sha256(token), now, idleMinutes],
  );
  return r.rows[0] ?? null;
};

export const touchSession = async (db: Queryable, id: string, now: Date): Promise<void> => {
  await db.query('UPDATE session SET last_seen_at = $2 WHERE id = $1 AND last_seen_at < $2', [id, now]);
};

export const revokeSession = async (db: Queryable, id: string, now: Date, reason: RevokeReason): Promise<void> => {
  await db.query('UPDATE session SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL', [
    id,
    now,
    reason,
  ]);
};

export const revokeUserSessions = async (
  db: Queryable,
  userId: string,
  now: Date,
  reason: RevokeReason,
  exceptSessionId: string | null = null,
): Promise<void> => {
  await db.query(
    `UPDATE session SET revoked_at = $2, revoke_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4)`,
    [userId, now, reason, exceptSessionId],
  );
};
