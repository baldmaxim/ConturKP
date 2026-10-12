// Этап 16: персональные токены чат-клиентов (миграция 0040, проект §3). Сам токен в БД не хранится — только SHA-256
// и первые символы для показа; значение возвращается один раз при выпуске и никуда не записывается.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './pool.ts';

export type ApiTokenScope = 'read' | 'propose';

export interface IApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  client_kind: 'codex' | 'cursor' | 'other';
  token_prefix: string;
  scopes: ApiTokenScope[];
  lifetime_days: number;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}

const COLUMNS = 'id, user_id, name, client_kind, token_prefix, scopes, lifetime_days, created_at, expires_at, last_used_at, revoked_at, revoked_by';

export const API_TOKEN_PREFIX = 'kkp_';

export const apiTokenSha256 = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

// Вид токена портала: по нему значение узнаётся при вырезании секретов из ответов (I17).
export const API_TOKEN_PATTERN = /kkp_[A-Za-z0-9_-]{43}/g;

export interface IIssueApiToken {
  userId: string;
  name: string;
  clientKind: 'codex' | 'cursor' | 'other';
  scopes: ApiTokenScope[];
  lifetimeDays: number;
}

export const issueApiToken = async (db: Queryable, d: IIssueApiToken): Promise<{ row: IApiTokenRow; token: string }> => {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const r = await db.query<IApiTokenRow>(
    `INSERT INTO api_token (user_id, name, client_kind, token_sha256, token_prefix, scopes, lifetime_days, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $7))
     RETURNING ${COLUMNS}`,
    [d.userId, d.name, d.clientKind, apiTokenSha256(token), token.slice(0, 8), d.scopes, d.lifetimeDays],
  );
  return { row: r.rows[0]!, token };
};

export const listApiTokens = async (db: Queryable, userId: string): Promise<IApiTokenRow[]> =>
  (await db.query<IApiTokenRow>(`SELECT ${COLUMNS} FROM api_token WHERE user_id = $1 ORDER BY created_at DESC, id`, [userId])).rows;

export const getApiToken = async (db: Queryable, id: string, lock = false): Promise<IApiTokenRow | null> =>
  (await db.query<IApiTokenRow>(`SELECT ${COLUMNS} FROM api_token WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;

export const activeApiTokenCount = async (db: Queryable, userId: string): Promise<number> =>
  Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM api_token WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [userId])).rows[0]!.n);

// Действующий токен по значению из заголовка: не отозван и не истёк. Владелец проверяется загрузкой контекста прав.
export const findActiveApiToken = async (db: Queryable, token: string): Promise<IApiTokenRow | null> =>
  (await db.query<IApiTokenRow>(`SELECT ${COLUMNS} FROM api_token WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()`, [apiTokenSha256(token)])).rows[0] ?? null;

export const revokeApiToken = async (db: Queryable, id: string, byUserId: string): Promise<void> => {
  await db.query('UPDATE api_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, byUserId]);
};

// Отметка последнего вызова — не чаще раза в минуту: каждый вызов инструмента строку не переписывает.
export const touchApiToken = async (db: Queryable, id: string): Promise<void> => {
  await db.query("UPDATE api_token SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [id]);
};
