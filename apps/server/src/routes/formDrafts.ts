// Приложения этапа (этап 11; D-031 В-11-4…В-11-8; portal-api §2.8): создание по утверждённой ревизии шаблона,
// мастер заполнения, быстрые действия с полем (ввести, выбрать формулировку, принять предложение системы, подтвердить
// заново, обсудить, очистить), история версий, «заполнено», перенос на новую ревизию. Значение — новая версия с
// If-Match по версии поля: второй редактор по старой версии получает 412. Заменённые и конфликтующие основания
// значение не подтверждают (409 basis_superseded / basis_conflict).
import { CreateDraftRequest, FieldActionRequest, MigrateDraftRequest } from '@kontur/contracts';
import { allFields, fieldMap, formatEtag, planMigration, validateValue, valueFromFactText, type FieldValue, type IField } from '@kontur/core';
import {
  appendFieldVersion,
  createDraft,
  draftFields,
  fieldBasisProblems,
  fieldHistory,
  fieldVersionNumber,
  getDraft,
  getTemplateRevision,
  getWordingVersion,
  listDrafts,
  readableFragments,
  setDraftStatus,
  tenderFactsByType,
  type IAccessContext,
  type IBasisInput,
  type IDraftRow,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import { Router, type Request } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { BASIS_PROBLEM_TEXT, draftView, historyView, issuesForDraft, stageIssues } from '../formsView.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';
import { loadStage } from './stages.ts';

type Cap = 'tender.read' | 'application.fill';

export const loadDraft = async (db: Queryable, ctx: IAccessContext, id: string, cap: Cap = 'tender.read', lock = false): Promise<IDraftRow> => {
  const d = await getDraft(db, id, lock);
  if (!d || !hasTenderCap(ctx, d.tender_id, 'tender.read')) throw notFound({ entityType: 'application_draft', entityId: id });
  if (!hasTenderCap(ctx, d.tender_id, cap)) throw forbidden(cap, { entityType: 'application_draft', entityId: id, tenderId: d.tender_id });
  return d;
};

export const draftTarget = (d: IDraftRow) => ({ tenderId: d.tender_id, entityType: 'application_draft', entityId: d.id });

const keyParam = (req: Request): string => {
  const k = req.params.key;
  if (typeof k !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(k)) throw notFound({ entityType: 'draft_field' });
  return k;
};

// Основания новой версии — читаемые автором и действующие (иначе 409 с перечнем и причиной).
export const requireUsableBases = async (db: Queryable, ctx: IAccessContext, d: IDraftRow, bases: readonly IBasisInput[]): Promise<void> => {
  const fragments = bases.filter((b) => b.basisType === 'fragment').map((b) => b.id);
  const readable = await readableFragments(db, ctx, fragments);
  if (fragments.some((f) => !readable.has(f))) throw conflict('среди оснований есть фрагменты, которые вы не можете читать', 'restricted_fragments', draftTarget(d));
  const problems = await fieldBasisProblems(db, d.stage_id, bases);
  if (problems.length > 0) {
    const conflicting = problems.some((p) => p.cause === 'fact_conflict');
    throw conflict(
      conflicting ? 'основание в конфликте: значение по нему не подтверждается' : 'основание заменено: выберите действующее основание',
      conflicting ? 'basis_conflict' : 'basis_superseded',
      draftTarget(d),
      { superseded: problems.map((p) => ({ ...p, text: BASIS_PROBLEM_TEXT[p.cause] ?? p.cause })) },
    );
  }
};

// Приложение «заполнено» возвращается в работу любой новой версией поля.
export const reopenIfComplete = async (db: Queryable, d: IDraftRow, userId: string): Promise<void> => {
  if (d.status === 'complete') await setDraftStatus(db, { draftId: d.id, status: 'in_progress', userId });
};

const fieldOf = (d: IDraftRow, key: string): IField => {
  const f = fieldMap(d.field_schema).get(key);
  if (!f) throw notFound({ entityType: 'draft_field', details: { key } });
  return f;
};

const checkedValue = (f: IField, raw: unknown): FieldValue => {
  const r = validateValue(f, raw);
  if (!r.ok) throw new HttpError(400, 'VALIDATION_FAILED', 'значение не проходит схему поля', { errors: r.errors.map((message) => ({ path: f.key, message })) });
  return r.value;
};

const fieldIdOf = async (db: Queryable, draftId: string, key: string): Promise<string> => {
  const r = (await db.query<{ id: string }>('SELECT id FROM draft_field WHERE draft_id = $1 AND field_key = $2', [draftId, key])).rows[0];
  if (!r) throw notFound({ entityType: 'draft_field', details: { key } });
  return r.id;
};

const fieldResponse = async (db: Queryable, ctx: IAccessContext, draftId: string, key: string) => {
  const d = (await getDraft(db, draftId))!;
  const view = await draftView(db, ctx, d);
  const field = view.sections.flatMap((s) => s.fields).find((f) => f.key === key)!;
  return { draft: { id: view.id, status: view.status, etag: view.etag, blocking: view.blocking, issues: view.issues }, field };
};

const runFieldAction = async (client: PoolClient, ctx: IAccessContext, req: Request) => {
  const d = await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill', true);
  const key = keyParam(req);
  const f = fieldOf(d, key);
  const fieldId = await fieldIdOf(client, d.id, key);
  if (d.status === 'superseded') throw conflict('приложение заменено переносом на новую ревизию', 'draft_superseded', draftTarget(d));
  await client.query("SELECT pg_advisory_xact_lock(hashtext('draft_field_version'), hashtext($1::text))", [fieldId]);
  const current = await fieldVersionNumber(client, fieldId);
  if (requireIfMatch(req, fieldId) !== current.version) throw versionConflict({ version: current.version, etag: formatEtag(fieldId, current.version) });
  const body = parseBody(FieldActionRequest, req.body);
  const latest = current.id ? (await fieldHistory(client, fieldId, d.stage_id))[0]! : null;
  const base = { tenderId: d.tender_id, stageId: d.stage_id, draftId: d.id, fieldId, userId: ctx.principal.userId };
  let input: Parameters<typeof appendFieldVersion>[1];
  switch (body.action) {
    case 'set': {
      const bases: IBasisInput[] = body.bases.map((b) => ({ basisType: b.type, id: b.id.toLowerCase() }));
      await requireUsableBases(client, ctx, d, bases);
      input = { ...base, value: checkedValue(f, body.value), state: 'edited', origin: 'manual', bases };
      break;
    }
    case 'choose_wording': {
      const w = await getWordingVersion(client, body.wordingVersionId.toLowerCase());
      if (!w || w.status !== 'approved' || (w.scope_tender_id !== null && w.scope_tender_id !== d.tender_id)) {
        throw conflict('формулировка не утверждена или не относится к этому тендеру', 'wording_not_approved', draftTarget(d));
      }
      if (f.type !== 'text') throw conflict('формулировка выбирается для текстового поля', 'wording_field_type', draftTarget(d));
      input = { ...base, value: checkedValue(f, w.text), state: 'accepted', origin: 'approved_wording', wordingVersionId: w.version_id, bases: [] };
      break;
    }
    case 'accept_fact': {
      const type = f.meaning?.startsWith('fact:') ? f.meaning.slice(5) : null;
      const fact = type ? (await tenderFactsByType(client, d.tender_id, [type])).find((x) => x.evidence_fact_id === body.evidenceFactId.toLowerCase()) : undefined;
      if (!fact) throw conflict('факт не относится к смыслу поля или к этому тендеру', 'fact_not_applicable', draftTarget(d));
      const readable = await readableFragments(client, ctx, fact.fragment_ids);
      if (fact.fragment_ids.some((x) => !readable.has(x))) throw conflict('основания факта вы не можете читать', 'restricted_fragments', draftTarget(d));
      const bases: IBasisInput[] = [{ basisType: 'evidence_fact', id: fact.evidence_fact_id }];
      await requireUsableBases(client, ctx, d, bases);
      const value = valueFromFactText(f, fact.raw_value);
      if (value === null) throw conflict('из фразы факта нельзя взять значение этого поля', 'fact_value_unavailable', draftTarget(d));
      input = { ...base, value, state: 'accepted', origin: 'system_suggestion', bases };
      break;
    }
    case 'confirm': {
      if (!latest || latest.value === null || latest.state === 'cleared') throw conflict('нечего подтверждать: значения нет', 'nothing_to_confirm', draftTarget(d));
      const bases: IBasisInput[] = latest.bases.map((b) => ({
        basisType: b.basisType,
        id: (b.fragmentId ?? b.decisionId ?? b.requirementRevisionId ?? b.evidenceFactId)!,
        quote: b.quote,
      }));
      await requireUsableBases(client, ctx, d, bases);
      const keepWording = latest.origin === 'approved_wording' && latest.wording_version_id ? await getWordingVersion(client, latest.wording_version_id) : null;
      const wording = keepWording && keepWording.status === 'approved' ? keepWording.version_id : null;
      const origin = wording ? 'approved_wording' : latest.origin === 'system_suggestion' ? 'system_suggestion' : 'manual';
      input = { ...base, value: checkedValue(f, latest.value), state: 'accepted', origin, wordingVersionId: wording, bases };
      break;
    }
    case 'discuss': {
      if (body.responsibleUserId && !(await client.query('SELECT 1 FROM tender_member WHERE tender_id = $1 AND user_id = $2 AND removed_at IS NULL', [d.tender_id, body.responsibleUserId])).rowCount) {
        throw conflict('ответственный — участник тендера', 'responsible_not_member', draftTarget(d));
      }
      let questionId: string | null = null;
      if (body.createQuestion) {
        if (!hasTenderCap(ctx, d.tender_id, 'requirement.create')) throw forbidden('requirement.create', draftTarget(d));
        questionId = (
          await client.query<{ id: string }>(
            'INSERT INTO customer_question (tender_id, stage_id, text, responsible_user_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id',
            [d.tender_id, d.stage_id, (body.questionText ?? `${f.label}: ${body.comment}`).slice(0, 4000), body.responsibleUserId ?? null, ctx.principal.userId],
          )
        ).rows[0]!.id;
      }
      input = {
        ...base,
        value: latest && latest.state !== 'cleared' ? latest.value : null,
        state: 'needs_discussion',
        origin: 'manual',
        comment: body.comment,
        responsibleUserId: body.responsibleUserId ?? null,
        customerQuestionId: questionId,
        bases: [],
      };
      break;
    }
    case 'clear':
      input = { ...base, value: null, state: 'cleared', origin: 'manual', bases: [] };
      break;
  }
  await reopenIfComplete(client, d, ctx.principal.userId);
  const versionId = await appendFieldVersion(client, input);
  return { d, key, fieldId, versionId, action: body.action, version: current.version + 1 };
};

export const formDraftsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/stages/:id/application-drafts',
    query(pool, 'forms.draft.list', 'application_draft', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      if (!hasTenderCap(ctx, stage.tender_id, 'tender.read')) throw notFound({ entityType: 'tender_stage', entityId: stage.id });
      const drafts = await listDrafts(pool, stage.id);
      const items = [];
      for (const d of drafts) {
        const fields = await draftFields(pool, d);
        const issues = d.status === 'superseded' ? null : await issuesForDraft(pool, d, fields);
        const required = allFields(d.field_schema).length;
        items.push({
          id: d.id,
          title: d.title,
          status: d.status,
          isDemo: d.is_demo,
          template: { id: d.template_id, name: d.template_name, ownerKind: d.owner_kind, revisionSeq: d.revision_seq, newerRevisionAvailable: d.current_revision_id !== null && d.current_revision_id !== d.template_revision_id },
          filled: fields.filter((f) => f.latest && f.latest.state !== 'cleared' && f.latest.value !== null).length,
          fields: required,
          blocking: issues?.blocking ?? 0,
          etag: formatEtag(d.id, d.row_version),
          createdAt: d.created_at.toISOString(),
        });
      }
      res.json({ items, canFill: hasTenderCap(ctx, stage.tender_id, 'application.fill') });
    }),
  );

  router.post(
    '/stages/:id/application-drafts',
    command(pool, {
      action: 'forms.draft.create',
      entityType: 'application_draft',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        if (!hasTenderCap(ctx, stage.tender_id, 'application.fill')) throw forbidden('application.fill', { entityType: 'tender_stage', entityId: stage.id, tenderId: stage.tender_id });
      },
      run: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        const body = parseBody(CreateDraftRequest, req.body);
        const rev = await getTemplateRevision(client, body.templateRevisionId.toLowerCase());
        const tgt = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        if (!rev || (rev.tender_id !== null && rev.tender_id !== stage.tender_id)) throw notFound({ entityType: 'template_revision', entityId: body.templateRevisionId });
        if (rev.status !== 'approved') throw conflict('приложение создаётся по утверждённой действующей ревизии шаблона', 'revision_not_approved', tgt);
        const created = await createDraft(client, { tenderId: stage.tender_id, stageId: stage.id, revision: rev, title: body.title ?? rev.template_name, userId: ctx.principal.userId });
        const d = (await getDraft(client, created.draftId))!;
        return {
          status: 201,
          body: await draftView(client, ctx, d),
          etag: formatEtag(d.id, d.row_version),
          audit: [{ action: 'forms.draft.create', entityType: 'application_draft', entityId: d.id, tenderId: d.tender_id, details: { stageId: stage.id, templateRevisionId: rev.id, isDemo: rev.is_demo } }],
        };
      },
    }),
  );

  router.get(
    '/application-drafts/:id',
    query(pool, 'forms.draft.read', 'application_draft', async (ctx, req, res) => {
      const d = await loadDraft(pool, ctx, uuidParam(req, 'id', 'application_draft'));
      res.json({ ...(await draftView(pool, ctx, d)), canFill: hasTenderCap(ctx, d.tender_id, 'application.fill') });
    }),
  );

  router.put(
    '/application-drafts/:id/fields/:key',
    command(pool, {
      action: 'forms.field.set',
      entityType: 'draft_field',
      authorize: async (client, ctx, req) => void (await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill')),
      run: async (client, ctx, req) => {
        const r = await runFieldAction(client, ctx, req);
        const out = await fieldResponse(client, ctx, r.d.id, r.key);
        return {
          status: 200,
          body: out,
          etag: formatEtag(r.fieldId, r.version),
          audit: [{ action: 'forms.field.set', entityType: 'draft_field', entityId: r.fieldId, tenderId: r.d.tender_id, details: { draftId: r.d.id, key: r.key, action: r.action, version: r.version } }],
        };
      },
    }),
  );

  router.get(
    '/application-drafts/:id/fields/:key/history',
    query(pool, 'forms.field.history', 'draft_field', async (ctx, req, res) => {
      const d = await loadDraft(pool, ctx, uuidParam(req, 'id', 'application_draft'));
      const fieldId = await fieldIdOf(pool, d.id, keyParam(req));
      res.json({ items: await historyView(pool, ctx, await fieldHistory(pool, fieldId, d.stage_id)) });
    }),
  );

  router.post(
    '/application-drafts/:id/complete',
    command(pool, {
      action: 'forms.draft.complete',
      entityType: 'application_draft',
      authorize: async (client, ctx, req) => void (await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill')),
      run: async (client, ctx, req) => {
        const d = await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill', true);
        if (requireIfMatch(req, d.id) !== d.row_version) throw versionConflict({ rowVersion: d.row_version });
        if (d.status !== 'in_progress') throw conflict(d.status === 'complete' ? 'приложение уже заполнено' : 'приложение заменено', 'draft_not_in_progress', draftTarget(d));
        const issues = await issuesForDraft(client, d);
        if (issues.blocking > 0) throw conflict('остались незавершённые пункты', 'incomplete', draftTarget(d), { issues: issues.issues.filter((i) => i.blocking) });
        await setDraftStatus(client, { draftId: d.id, status: 'complete', userId: ctx.principal.userId });
        const after = (await getDraft(client, d.id))!;
        return {
          status: 200,
          body: await draftView(client, ctx, after),
          etag: formatEtag(after.id, after.row_version),
          audit: [{ action: 'forms.draft.complete', entityType: 'application_draft', entityId: d.id, tenderId: d.tender_id, details: { stageId: d.stage_id } }],
        };
      },
    }),
  );

  // Перенос на новую ревизию (D-031 В-11-8): новый черновик, значения по ключу и типу — «перенесено — подтвердите»
  // с действующими основаниями; отчёт — изменения подписи, единицы, вариантов, применимости, удалённые и новые поля.
  router.post(
    '/application-drafts/:id/migrate',
    command(pool, {
      action: 'forms.draft.migrate',
      entityType: 'application_draft',
      authorize: async (client, ctx, req) => void (await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill')),
      run: async (client, ctx, req) => {
        const d = await loadDraft(client, ctx, uuidParam(req, 'id', 'application_draft'), 'application.fill', true);
        if (requireIfMatch(req, d.id) !== d.row_version) throw versionConflict({ rowVersion: d.row_version });
        if (d.status === 'superseded') throw conflict('приложение уже перенесено', 'draft_superseded', draftTarget(d));
        const body = parseBody(MigrateDraftRequest, req.body);
        const targetId = body.templateRevisionId?.toLowerCase() ?? d.current_revision_id;
        const rev = targetId ? await getTemplateRevision(client, targetId) : null;
        if (!rev || rev.template_id !== d.template_id || rev.status !== 'approved' || rev.id === d.template_revision_id) {
          throw conflict('перенос — на другую утверждённую ревизию того же шаблона', 'migration_target_invalid', draftTarget(d));
        }
        const fields = await draftFields(client, d);
        const values = new Map(fields.map((f) => [f.field_key, f.latest && f.latest.state !== 'cleared' ? f.latest.value : null]));
        const plan = planMigration(d.field_schema, rev.field_schema, values);
        // Основания переносятся только действующие; заменённые — в отчёт (значение всё равно требует подтверждения).
        const carriedBases = new Map<string, { sourceId: string; bases: IBasisInput[] }>();
        const droppedBases: { key: string; cause: string }[] = [];
        for (const c of plan.carried) {
          const src = fields.find((f) => f.field_key === c.key)?.latest;
          if (!src) continue;
          const all: IBasisInput[] = src.bases.map((b) => ({ basisType: b.basisType, id: (b.fragmentId ?? b.decisionId ?? b.requirementRevisionId ?? b.evidenceFactId)!, quote: b.quote }));
          const problems = await fieldBasisProblems(client, d.stage_id, all);
          for (const p of problems) droppedBases.push({ key: c.key, cause: p.cause });
          carriedBases.set(c.key, { sourceId: src.id, bases: all.filter((b) => !problems.some((p) => p.id === b.id)) });
        }
        const report = { fromRevisionId: d.template_revision_id, toRevisionId: rev.id, carried: plan.carried.map((c) => ({ key: c.key, label: c.label, changes: c.changes })), dropped: plan.dropped, added: plan.added, droppedBases };
        const created = await createDraft(client, { tenderId: d.tender_id, stageId: d.stage_id, revision: rev, title: d.title, userId: ctx.principal.userId, migratedFromDraftId: d.id, migrationReport: report });
        for (const c of plan.carried) {
          const src = carriedBases.get(c.key);
          if (!src) continue;
          await appendFieldVersion(client, {
            tenderId: d.tender_id,
            stageId: d.stage_id,
            draftId: created.draftId,
            fieldId: created.fieldIds.get(c.key)!,
            value: c.value,
            state: 'carried_over',
            origin: 'carried_over',
            carriedFromVersionId: src.sourceId,
            userId: ctx.principal.userId,
            bases: src.bases,
          });
        }
        await setDraftStatus(client, { draftId: d.id, status: 'superseded', userId: ctx.principal.userId });
        const after = (await getDraft(client, created.draftId))!;
        return {
          status: 201,
          body: { ...(await draftView(client, ctx, after)), migration: report },
          etag: formatEtag(after.id, after.row_version),
          audit: [{ action: 'forms.draft.migrate', entityType: 'application_draft', entityId: after.id, tenderId: d.tender_id, details: { from: d.id, toRevisionId: rev.id, carried: plan.carried.length, dropped: plan.dropped.length, added: plan.added.length } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/application-issues',
    query(pool, 'forms.issues.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      if (!hasTenderCap(ctx, stage.tender_id, 'tender.read')) throw notFound({ entityType: 'tender_stage', entityId: stage.id });
      res.json({ items: await stageIssues(pool, stage.id) });
    }),
  );

  return router;
};
