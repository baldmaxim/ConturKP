// Явная команда локального распознавания редакции (этап 05a, OD-1, OD-2, D-024). Права — как у приёма
// RDWeb: редакция тендера — source.write, редакция договора видна с contract.read, команда — contract.manage;
// распознавание договора права чтения не выдаёт (OD-3). Повтор той же идентичности возвращает прежний прогон (идемпотентность).
// Ответ не содержит качества и текста: у contract.manage без contract.read содержимого нет.
import { describeLocalRecognizer, localSettings, type ILocalOcrEngineFactory } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { enqueueLocalRecognition, getRevision, getRun, revisionRecognitionInfo, type Pool } from '@kontur/db';
import { Router } from 'express';
import { command, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { outcomeOf } from '../recognitionMappers.ts';
import { requireRevisionWrite } from './contractScope.ts';

const REFUSALS: Record<string, string> = {
  unsupported_format: 'формат оригинала не входит в перечень локального распознавания: PDF, DOCX, XLSX, CSV (OD-4)',
  route_rdweb: 'маршрут редакции — RDWeb: у неё есть прогон RDWeb или документ помечен «только RDWeb» (OD-1)',
  route_auto_requires_command: 'PDF с политикой auto распознаётся локально только явной командой',
  not_found: 'редакция не найдена',
};

export const localRecognitionRouter = (pool: Pool, config: IAppConfig, ocr: ILocalOcrEngineFactory | null): Router => {
  const router = Router();
  const settings = localSettings(config, ocr);

  router.post(
    '/document-revisions/:id/local-recognitions',
    command(pool, {
      action: 'recognition.local.request',
      entityType: 'recognition_run',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document_revision');
        const rev = await getRevision(client, ctx, id);
        if (!rev) throw notFound({ entityType: 'document_revision', entityId: id });
        requireRevisionWrite(ctx, rev, { entityType: 'document_revision', entityId: id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document_revision');
        const rev = (await getRevision(client, ctx, id))!;
        const target = { tenderId: rev.tender_id, entityId: id };
        const info = await revisionRecognitionInfo(client, id);
        if (!info?.input_format) {
          throw new HttpError(409, 'STATE_CONFLICT', REFUSALS.unsupported_format, { current: { reason: 'unsupported_format' } }, target);
        }
        const descriptor = await describeLocalRecognizer(info.input_format, settings);
        const out = await enqueueLocalRecognition(client, { revisionId: id, descriptor, createdBy: ctx.principal.userId });
        if (out.kind === 'refused') {
          throw new HttpError(409, 'STATE_CONFLICT', REFUSALS[out.reason] ?? out.reason, { current: { reason: out.reason } }, target);
        }
        if (out.kind === 'active') {
          const active = (await getRun(client, out.runId))!;
          throw new HttpError(
            409,
            'STATE_CONFLICT',
            'по этой редакции уже идёт распознавание: дождитесь его завершения или отмените задание',
            { current: { reason: 'recognition_in_progress', runId: active.id, engine: active.engine, status: active.status } },
            target,
          );
        }
        const run = (await getRun(client, out.runId))!;
        const reused = out.kind === 'reused';
        return {
          status: reused ? 200 : 202,
          body: {
            reused,
            run: { id: run.id, documentRevisionId: id, engine: run.engine, status: run.status, outcome: outcomeOf(run.status), createdAt: run.created_at.toISOString() },
          },
          audit: [
            {
              action: 'recognition.local.request',
              entityType: 'recognition_run',
              entityId: run.id,
              tenderId: rev.tender_id,
              details: { documentRevisionId: id, reused, inputFormat: descriptor.inputFormat, processing: descriptor.processing },
            },
          ],
        };
      },
    }),
  );

  return router;
};
