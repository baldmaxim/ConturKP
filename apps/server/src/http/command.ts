// Обёртки обработчиков: транзакция команды, идемпотентность, If-Match и аудит.
// Каждая команда и каждый отказ пишут audit_event (portal-api §1, A25).
import { createHash } from 'node:crypto';
import { parseIfMatch } from '@kontur/core';
import {
  accessFingerprint,
  findIdempotent,
  lockIdempotencyKey,
  saveIdempotent,
  withTransaction,
  writeAudit,
  type IAccessContext,
  type IAuditInput,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { requireCtx, stateOf } from './context.ts';
import { fromPgError, fromStorageError, HttpError, validation } from './errors.ts';

export type AuditRecord = Omit<IAuditInput, 'actorUserId' | 'principalKind' | 'requestId' | 'outcome'>;

export interface ICommandResult {
  status: number;
  body: unknown;
  etag?: string;
  audit: AuditRecord[];
  // Побочные заголовки ответа (cookie); при повторе по ключу идемпотентности не вызываются.
  respond?: (res: Response) => void;
  // Ссылка на созданную запись для команд с replay: в записи идемпотентности хранится она, а не тело ответа (R15-01).
  replayRef?: unknown;
}

export interface IReplayedResponse {
  body: unknown;
  etag?: string;
}

export interface ICommandSpec {
  action: string;
  entityType: string;
  idempotent?: boolean;
  // Проверка текущих прав и области объекта. Выполняется в транзакции команды до выдачи
  // сохранённого ответа по ключу идемпотентности и до run (R02-01): повтор не обходит
  // отзыв назначения или роли. run повторяет проверки под своими блокировками.
  authorize: (client: PoolClient, ctx: IAccessContext, req: Request) => Promise<void>;
  // Материал хэша запроса для идемпотентности; по умолчанию — метод, URL и JSON-тело.
  requestKey?: (req: Request) => string;
  // Подготовка в отдельной транзакции до команды, после проверки прав (этап 09, R09-01): например, обработка
  // поступивших событий этапа — её результат сохраняется, даже если сама команда получит отказ.
  prepare?: (client: PoolClient, ctx: IAccessContext, req: Request) => Promise<void>;
  run: (client: PoolClient, ctx: IAccessContext, req: Request) => Promise<ICommandResult>;
  // Ответ с содержимым, закрытость которого зависит от прав читателя (письмо-основание, причина решения по нему):
  // тело ответа не сохраняется, а при повторе строится заново по текущим правам из replayRef (R15-01). Отзыв права
  // после команды закрывает текст и в повторном ответе; второй записи повтор не создаёт.
  replay?: (client: PoolClient, ctx: IAccessContext, req: Request, ref: unknown) => Promise<IReplayedResponse>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidParam = (req: Request, name: string, entityType: string): string => {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(404, 'NOT_FOUND', 'Объект не найден или нет доступа', {}, { entityType });
  return value.toLowerCase();
};

export const parseBody = <T>(schema: ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw validation(r.error);
  return r.data;
};

// Версия из If-Match для объекта id; без заголовка — 428, иначе сравнение делает вызывающий.
export const requireIfMatch = (req: Request, id: string): number => {
  const parsed = parseIfMatch(req.header('if-match'));
  if (parsed.kind === 'missing') throw new HttpError(428, 'PRECONDITION_REQUIRED', 'изменение требует заголовка If-Match');
  if (parsed.kind === 'invalid' || parsed.id !== id) {
    throw new HttpError(412, 'VERSION_CONFLICT', 'If-Match не относится к этому объекту');
  }
  return parsed.rowVersion;
};

// Идентификатор записи из ссылки сохранённого ответа; ссылка иного вида ответа не даёт.
export const replayId = (ref: unknown, key: string): string => {
  const id = ref && typeof ref === 'object' ? (ref as Record<string, unknown>)[key] : undefined;
  if (typeof id !== 'string') throw new HttpError(409, 'STATE_CONFLICT', 'сохранённый ответ команды недоступен: перечитайте объект');
  return id;
};

export const versionConflict = (current: unknown): HttpError =>
  new HttpError(412, 'VERSION_CONFLICT', 'объект изменён после чтения; перечитайте и повторите', { current });

// Отказ пишется в отдельной транзакции: транзакция команды к этому моменту откатана.
const auditFailure = async (pool: Pool, req: Request, action: string, entityType: string, err: HttpError): Promise<void> => {
  const state = stateOf(req);
  const ctx = state.auth?.ctx ?? null;
  await writeAudit(pool, {
    actorUserId: ctx?.principal.userId ?? null,
    principalKind: ctx ? 'human' : 'anonymous',
    action,
    entityType: err.target.entityType ?? entityType,
    entityId: err.target.entityId ?? null,
    // Цель без тендера (шаблон компании) передаёт пустую строку: в журнал — null, иначе отказ становился 500 (S12-02).
    tenderId: err.target.tenderId || null,
    requestId: state.requestId,
    // Отказ по матрице блокеров (этап 13) — тоже «запрещено», с кодами блокеров в подробностях (A25).
    outcome: err.status === 401 || err.status === 403 || err.status === 404 || err.code === 'BLOCKER_PRESENT' ? 'denied' : 'failed',
    details: { code: err.code, method: req.method, path: req.originalUrl.split('?')[0], ...err.target.details },
  });
};

export const toHttpError = (err: unknown): HttpError | null => (err instanceof HttpError ? err : (fromStorageError(err) ?? fromPgError(err)));

export const command =
  (pool: Pool, spec: ICommandSpec) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ctx = requireCtx(req);
      const key = spec.idempotent ? req.header('idempotency-key') : undefined;
      if (spec.idempotent && (!key || key.length < 8 || key.length > 200)) {
        throw new HttpError(400, 'VALIDATION_FAILED', 'команда требует заголовка Idempotency-Key (8–200 символов)');
      }
      const requestHash = createHash('sha256')
        .update(spec.requestKey ? spec.requestKey(req) : `${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`)
        .digest('hex');
      if (spec.prepare) {
        const prepare = spec.prepare;
        await withTransaction(pool, async (client) => {
          await spec.authorize(client, ctx, req);
          await prepare(client, ctx, req);
        });
      }
      const result = await withTransaction(pool, async (client) => {
        await spec.authorize(client, ctx, req);
        if (key) {
          await lockIdempotencyKey(client, ctx.principal.userId, key);
          const stored = await findIdempotent(client, ctx.principal.userId, key);
          if (stored) {
            if (stored.requestHash !== requestHash) {
              throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'ключ уже использован с другим запросом');
            }
            const saved = stored.body as { body?: unknown; etag?: string; ref?: unknown; access?: string };
            if (spec.replay) {
              // Сохранённого тела у такой команды нет; запись без ссылки заново не показывается.
              if (saved.ref === undefined) throw new HttpError(409, 'STATE_CONFLICT', 'сохранённый ответ команды недоступен: перечитайте объект');
              const again = await spec.replay(client, ctx, req, saved.ref);
              const rebuilt: ICommandResult & { replay: boolean } = { status: stored.status, body: again.body, audit: [], replay: true };
              if (again.etag) rebuilt.etag = again.etag;
              return rebuilt;
            }
            // Сохранённое тело построено по правам на момент первого выполнения. Если права с тех пор изменились (отзыв
            // `mail.read`, назначения, роли, доступа к договору) или запись создана до привязки к правам, тело не отдаётся:
            // команда уже выполнена, второй раз не выполняется, объект нужно перечитать (S15-14, D-036).
            if (saved.access !== accessFingerprint(ctx)) {
              throw new HttpError(409, 'STATE_CONFLICT', 'команда уже выполнена, но сохранённый ответ недоступен: права изменились или запись создана до обновления — перечитайте объект', { current: { reason: 'replay_unavailable' } });
            }
            const replayed: ICommandResult & { replay: boolean } = { status: stored.status, body: saved.body, audit: [], replay: true };
            if (saved.etag) replayed.etag = saved.etag;
            return replayed;
          }
        }
        const r = await spec.run(client, ctx, req);
        for (const a of r.audit) {
          await writeAudit(client, {
            ...a,
            actorUserId: ctx.principal.userId,
            principalKind: 'human',
            requestId: ctx.requestId,
            outcome: 'allowed',
          });
        }
        if (key) {
          if (spec.replay && r.replayRef === undefined) throw new Error(`команда ${spec.action}: replay без replayRef`);
          await saveIdempotent(client, ctx.principal.userId, key, {
            requestHash,
            status: r.status,
            body: spec.replay ? { ref: r.replayRef } : { body: r.body, ...(r.etag ? { etag: r.etag } : {}), access: accessFingerprint(ctx) },
          });
        }
        return { ...r, replay: false };
      });
      if (result.etag) res.setHeader('ETag', result.etag);
      if (result.replay) res.setHeader('Idempotent-Replayed', 'true');
      else result.respond?.(res);
      if (result.body === undefined) res.status(result.status).end();
      else res.status(result.status).json(result.body);
    } catch (err) {
      const httpErr = toHttpError(err);
      if (httpErr) await auditFailure(pool, req, spec.action, spec.entityType, httpErr);
      throw httpErr ?? err;
    }
  };

// Чтение: права проверяются в обработчике; отказ фиксируется в журнале.
export const query =
  (pool: Pool, action: string, entityType: string, handler: (ctx: IAccessContext, req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(requireCtx(req), req, res);
    } catch (err) {
      const httpErr = toHttpError(err);
      if (httpErr) await auditFailure(pool, req, action, entityType, httpErr);
      throw httpErr ?? err;
    }
  };

export { auditFailure };
