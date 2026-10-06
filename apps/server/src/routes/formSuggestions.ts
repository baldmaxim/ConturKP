// Предложения значений полей моделью (этап 11; D-031 В-11-5): запуск прогона по приложению с закреплённым входом,
// состояние прогона, решение человека по предложению. Принятое предложение — новая версия поля с цитатами-основаниями;
// заменённая цитата не подтверждает значение (409 basis_superseded), погашенное предложение принять нельзя.
import { createChatModel } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { DecideFieldSuggestionRequest, StartFieldSuggestionRunRequest } from '@kontur/contracts';
import { fieldMap, formatEtag, validateValue } from '@kontur/core';
import {
  appendFieldVersion,
  createFieldSuggestionRun,
  decideFieldSuggestion,
  fieldVersionNumber,
  getDraft,
  getFieldSuggestion,
  getFieldSuggestionRun,
  listFieldSuggestionRuns,
  type IFieldSuggestionRunRow,
  type Pool,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { notFound } from '../http/errors.ts';
import { draftView } from '../formsView.ts';
import { draftTarget, loadDraft, reopenIfComplete, requireUsableBases } from './formDrafts.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

const toRun = (r: IFieldSuggestionRunRow) => ({
  id: r.id,
  draftId: r.draft_id,
  status: r.status,
  coverage: r.coverage,
  failureCode: r.failure_code,
  model: r.model_provider ? { provider: r.model_provider, id: r.model_id, version: r.model_version } : null,
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
});

export const formSuggestionsRouter = (pool: Pool, config: IAppConfig): Router => {
  const router = Router();

  router.post(
    '/application-drafts/:id/suggestion-runs',
    command(pool, {
      action: 'forms.suggestion_run.request',
      entityType: 'field_suggestion_run',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill')),
      run: async (client, ctx, req) => {
        const d = await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill');
        if (d.status === 'superseded') throw conflict('приложение заменено переносом на новую ревизию', 'draft_superseded', draftTarget(d));
        const body = parseBody(StartFieldSuggestionRunRequest, req.body);
        const chat = createChatModel(config.chatModel);
        const r = await createFieldSuggestionRun(client, {
          tenderId: d.tender_id,
          stageId: d.stage_id,
          draftId: d.id,
          draftTitle: d.title,
          schema: d.field_schema,
          ctx,
          model: chat ? { providerId: chat.providerId, model: chat.model, version: chat.version } : null,
          fieldKeys: body.fieldKeys ?? null,
        });
        if (!r.ok && r.reason === 'no_scope') throw conflict('у этапа нет снимка области: зафиксируйте снимок источников', 'no_scope', draftTarget(d));
        if (!r.ok) throw conflict('нет полей, для которых модель предлагает значения', 'no_fields', draftTarget(d));
        return {
          status: 201,
          body: toRun(r.run),
          audit: [{ action: 'forms.suggestion_run.request', entityType: 'field_suggestion_run', entityId: r.run.id, tenderId: d.tender_id, details: { draftId: d.id, scopeId: r.run.evidence_scope_id, model: r.run.model_provider } }],
        };
      },
    }),
  );

  router.get(
    '/application-drafts/:id/suggestion-runs',
    query(pool, 'forms.suggestion_run.list', 'application_draft', async (ctx, req, res) => {
      const d = await loadDraft(pool, ctx, uuidParam(req, 'id', 'application_draft'));
      res.json({ items: (await listFieldSuggestionRuns(pool, d.id)).map(toRun) });
    }),
  );

  router.get(
    '/field-suggestion-runs/:id',
    query(pool, 'forms.suggestion_run.read', 'field_suggestion_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'field_suggestion_run');
      const r = await getFieldSuggestionRun(pool, id);
      if (!r || !hasTenderCap(ctx, r.tender_id, 'tender.read')) throw notFound({ entityType: 'field_suggestion_run', entityId: id });
      res.json(toRun(r));
    }),
  );

  const decide = (status: 'accepted' | 'rejected') =>
    command(pool, {
      action: status === 'accepted' ? 'forms.suggestion.accept' : 'forms.suggestion.reject',
      entityType: 'field_suggestion',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'field_suggestion');
        const s = await getFieldSuggestion(client, id);
        if (!s) throw notFound({ entityType: 'field_suggestion', entityId: id });
        await loadDraft(client, ctx, s.draft_id, 'application.fill');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'field_suggestion');
        const probe = (await getFieldSuggestion(client, id))!;
        const d = await loadDraft(client, ctx, probe.draft_id, 'application.fill', true);
        const s = (await getFieldSuggestion(client, id, true))!;
        if (requireIfMatch(req, s.id) !== s.row_version) throw versionConflict({ rowVersion: s.row_version });
        if (s.status === 'expired') throw conflict('основание предложения изменилось: предложение погашено', 'suggestion_expired', draftTarget(d));
        if (s.status !== 'open') throw conflict('предложение уже решено', 'suggestion_decided', draftTarget(d));
        if (d.status === 'superseded') throw conflict('приложение заменено переносом на новую ревизию', 'draft_superseded', draftTarget(d));
        const body = parseBody(DecideFieldSuggestionRequest, req.body);
        let versionId: string | null = null;
        if (status === 'accepted') {
          const f = fieldMap(d.field_schema).get(s.field_key);
          const check = f ? validateValue(f, s.value) : null;
          if (!f || !check?.ok) throw conflict('предложение не проходит схему поля', 'suggestion_invalid', draftTarget(d));
          const bases = s.evidence.map((e) => ({ basisType: 'fragment' as const, id: e.fragmentId, quote: e.quote }));
          await requireUsableBases(client, ctx, d, bases);
          await client.query("SELECT pg_advisory_xact_lock(hashtext('draft_field_version'), hashtext($1::text))", [s.field_id]);
          await reopenIfComplete(client, d, ctx.principal.userId);
          versionId = await appendFieldVersion(client, {
            tenderId: d.tender_id,
            stageId: d.stage_id,
            draftId: d.id,
            fieldId: s.field_id,
            value: check.value,
            state: 'accepted',
            origin: 'model_suggestion',
            suggestionId: s.id,
            userId: ctx.principal.userId,
            bases,
          });
        }
        await decideFieldSuggestion(client, { id: s.id, userId: ctx.principal.userId, status, reason: body.reason ?? null, fieldVersionId: versionId });
        const after = (await getFieldSuggestion(client, s.id))!;
        const view = await draftView(client, ctx, (await getDraft(client, d.id))!);
        const version = await fieldVersionNumber(client, s.field_id);
        return {
          status: 200,
          body: { suggestion: { id: after.id, status: after.status, fieldVersionId: after.field_version_id }, field: view.sections.flatMap((x) => x.fields).find((x) => x.fieldId === s.field_id) ?? null, draft: { id: view.id, status: view.status, etag: view.etag, blocking: view.blocking } },
          etag: formatEtag(after.id, after.row_version),
          audit: [
            {
              action: status === 'accepted' ? 'forms.suggestion.accept' : 'forms.suggestion.reject',
              entityType: 'field_suggestion',
              entityId: s.id,
              tenderId: d.tender_id,
              details: { draftId: d.id, key: s.field_key, fieldVersion: status === 'accepted' ? version.version : null },
            },
          ],
        };
      },
    });

  router.post('/field-suggestions/:id/accept', decide('accepted'));
  router.post('/field-suggestions/:id/reject', decide('rejected'));

  return router;
};
