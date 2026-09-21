// Приём файла телом запроса (portal-api §2.3, §2.4). Общий шаг для загрузки источников
// и импорта экспорта распознавания: права и имя проверяются ДО чтения тела, тело пишется
// в хранилище с лимитом, остаток отброшенного тела дочитывается — клиент получает ответ,
// а не обрыв соединения.
import type { IAppConfig } from '@kontur/config';
import { safeRelativePath } from '@kontur/core';
import type { Pool } from '@kontur/db';
import { BlobLimitError, type BlobStore, type IStoredBlob } from '@kontur/storage';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { auditFailure, toHttpError } from './command.ts';
import { HttpError } from './errors.ts';

const uploads = new WeakMap<Request, IStoredBlob>();

export const uploadName = (req: Request): string => {
  const raw = typeof req.query.name === 'string' ? req.query.name : '';
  const safe = safeRelativePath(raw);
  if (!safe.ok || safe.path.includes('/') || safe.path.length > 255) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'параметр name — имя файла без каталога');
  }
  return safe.path;
};

export const uploadedBlob = (req: Request): IStoredBlob | undefined => uploads.get(req);

export interface IReceiveUploadOptions {
  pool: Pool;
  store: BlobStore;
  config: IAppConfig;
  action: string;
  entityType: string;
  // Проверка прав и существования объекта до чтения тела.
  authorize: (req: Request) => Promise<void>;
}

export const receiveUpload = (o: IReceiveUploadOptions): RequestHandler => {
  const receive = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await o.authorize(req);
      uploadName(req);
      if (!req.is('application/octet-stream')) throw new HttpError(400, 'VALIDATION_FAILED', 'тело загрузки — application/octet-stream');
      const key = req.header('idempotency-key');
      if (!key || key.length < 8 || key.length > 200) {
        throw new HttpError(400, 'VALIDATION_FAILED', 'команда требует заголовка Idempotency-Key (8–200 символов)');
      }
      const declared = Number(req.header('content-length') ?? '0');
      if (declared > o.config.limits.maxUploadBytes) throw new BlobLimitError(o.config.limits.maxUploadBytes);
      await o.store.ensureDirs();
      uploads.set(req, await o.store.putStream(req, o.config.limits.maxUploadBytes, false));
      next();
    } catch (err) {
      const httpErr =
        err instanceof BlobLimitError
          ? new HttpError(413, 'VALIDATION_FAILED', `файл больше ${Math.round(o.config.limits.maxUploadBytes / 1048576)} МиБ`)
          : toHttpError(err);
      if (!httpErr) return next(err);
      req.resume();
      await auditFailure(o.pool, req, o.action, o.entityType, httpErr);
      next(httpErr);
    }
  };
  return (req, res, next) => {
    receive(req, res, next).catch(next);
  };
};
