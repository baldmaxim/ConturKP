// Шаблоны приложений, ревизии схемы forms/1, образцы форм и библиотека формулировок (этап 11; D-031 В-11-1…В-11-3,
// В-11-9; portal-api §2.8). Шаблоны компании и формулировки компании ведёт роль «руководитель» (admin.templates,
// wording.approve) — без доступа к содержимому тендеров; шаблон заказчика — руководитель тендера (template.manage),
// ревизия заказчика утверждается только с основанием. Демо-шаблон помечен и остаётся демонстрационным.
import type { IAppConfig } from '@kontur/config';
import {
  AddWordingVersionRequest,
  ApproveTemplateRevisionRequest,
  CreateTemplateRequest,
  CreateTemplateRevisionRequest,
  CreateWordingRequest,
  DecideWordingRequest,
  MarkupCheckRequest,
  WordingsQuery,
} from '@kontur/contracts';
import { allFields, fieldChanges, formatEtag, globalCapabilities, hasContentRole, validateSchema, type IFormSchema } from '@kontur/core';
import {
  addWordingVersion,
  approveTemplateRevision,
  createTemplate,
  createTemplateRevision,
  createWording,
  decideWordingVersion,
  getTemplate,
  getTemplateRevision,
  getWordingVersion,
  insertBlob,
  listTemplateRevisions,
  listTemplates,
  listWordings,
  readableFragments,
  retireTemplateRevision,
  wordingHistory,
  type IAccessContext,
  type ITemplateRevisionRow,
  type ITemplateRow,
  type IWordingRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router, type Request } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadedBlob, uploadName } from '../http/upload.ts';
import { analyzeMarkedSample } from '../releaseMarkup.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

const isTemplateAdmin = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('admin.templates');
const canApproveCompanyWording = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('wording.approve');

// Чтение шаблона: компании — пользователь с содержательной ролью; заказчика — участник тендера (иначе 404).
const canReadTemplate = (ctx: IAccessContext, tenderId: string | null): boolean =>
  tenderId === null ? hasContentRole(ctx.roles) || isTemplateAdmin(ctx) : hasTenderCap(ctx, tenderId, 'tender.read');

const canManage = (ctx: IAccessContext, tenderId: string | null): boolean => (tenderId === null ? isTemplateAdmin(ctx) : hasTenderCap(ctx, tenderId, 'template.manage'));

const loadTemplate = async (db: Queryable, ctx: IAccessContext, id: string, manage = false): Promise<ITemplateRow> => {
  const t = await getTemplate(db, id);
  if (!t || !canReadTemplate(ctx, t.tender_id)) throw notFound({ entityType: 'application_template', entityId: id });
  if (manage && !canManage(ctx, t.tender_id)) throw forbidden(t.tender_id ? 'template.manage' : 'admin.templates', { entityType: 'application_template', entityId: id, tenderId: t.tender_id ?? undefined });
  return t;
};

const loadRevision = async (db: Queryable, ctx: IAccessContext, id: string, manage = false, lock = false): Promise<ITemplateRevisionRow> => {
  const r = await getTemplateRevision(db, id, lock);
  if (!r || !canReadTemplate(ctx, r.tender_id)) throw notFound({ entityType: 'template_revision', entityId: id });
  if (manage && !canManage(ctx, r.tender_id)) throw forbidden(r.tender_id ? 'template.manage' : 'admin.templates', { entityType: 'template_revision', entityId: id, tenderId: r.tender_id ?? undefined });
  return r;
};

const toTemplate = (t: ITemplateRow, ctx: IAccessContext) => ({
  id: t.id,
  ownerKind: t.owner_kind,
  tenderId: t.tender_id,
  name: t.name,
  isDemo: t.is_demo,
  currentRevisionId: t.current_revision_id,
  currentSeq: t.current_seq,
  latestSeq: t.latest_seq,
  createdAt: t.created_at.toISOString(),
  canManage: canManage(ctx, t.tender_id),
  etag: formatEtag(t.id, t.row_version),
});

const toRevision = (r: ITemplateRevisionRow, withSchema: boolean) => ({
  id: r.id,
  templateId: r.template_id,
  templateName: r.template_name,
  ownerKind: r.owner_kind,
  isDemo: r.is_demo,
  tenderId: r.tender_id,
  seq: r.seq,
  status: r.status,
  schemaSha256: r.schema_sha256,
  title: r.field_schema.title,
  fieldCount: r.field_keys.length,
  requiredKeys: r.required_keys,
  sample: r.sample_blob_sha256 ? { sha256: r.sample_blob_sha256, name: r.sample_name } : null,
  markedSample: r.marked_sample_blob_sha256 ? { sha256: r.marked_sample_blob_sha256, name: r.marked_sample_name } : null,
  outputFormat: r.output_format,
  audience: r.audience,
  markup: r.markup,
  basis: { fragmentIds: r.basis_fragment_ids, decisionId: r.basis_decision_id, note: r.basis_note },
  createdAt: r.created_at.toISOString(),
  approvedAt: r.approved_at?.toISOString() ?? null,
  approvedBy: r.approved_by,
  etag: formatEtag(r.id, r.row_version),
  ...(withSchema ? { schema: r.field_schema } : {}),
});

const toWording = (w: IWordingRow) => ({
  wordingId: w.wording_id,
  scopeTenderId: w.scope_tender_id,
  title: w.title,
  versionId: w.version_id,
  version: w.version,
  text: w.text,
  tags: w.tags,
  status: w.status,
  proposedBy: { id: w.proposed_by, name: w.proposed_by_name },
  approvedAt: w.approved_at?.toISOString() ?? null,
  approvedVersionId: w.approved_version_id,
  etag: formatEtag(w.version_id, w.row_version),
});

// Отличия ревизии от предыдущей утверждённой: добавленные, удалённые и изменённые поля (D-031 В-11-9).
const revisionDiff = (prev: IFormSchema | null, next: IFormSchema) => {
  if (!prev) return null;
  const before = new Map(allFields(prev).map((f) => [f.key, f]));
  const after = new Map(allFields(next).map((f) => [f.key, f]));
  return {
    added: allFields(next).filter((f) => !before.has(f.key)).map((f) => ({ key: f.key, label: f.label, required: f.required !== undefined && f.required !== false })),
    removed: allFields(prev).filter((f) => !after.has(f.key)).map((f) => ({ key: f.key, label: f.label })),
    changed: allFields(prev)
      .filter((f) => after.has(f.key))
      .map((f) => ({ key: f.key, label: after.get(f.key)!.label, typeChanged: f.type !== after.get(f.key)!.type, changes: fieldChanges(f, after.get(f.key)!) }))
      .filter((c) => c.typeChanged || c.changes.length > 0),
  };
};

const tenderParam = (req: Request): string | null => {
  const raw = typeof req.query.tenderId === 'string' ? req.query.tenderId : null;
  return raw && /^[0-9a-f-]{36}$/iu.test(raw) ? raw.toLowerCase() : null;
};

export const formTemplatesRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  router.get(
    '/application-templates',
    query(pool, 'forms.template.list', 'application_template', async (ctx, req, res) => {
      const tenderId = tenderParam(req);
      if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      const rows = (await listTemplates(pool, ctx, tenderId)).filter((t) => canReadTemplate(ctx, t.tender_id));
      res.json({ items: rows.map((t) => toTemplate(t, ctx)), canManageCompany: isTemplateAdmin(ctx), canApproveCompanyWording: canApproveCompanyWording(ctx) });
    }),
  );

  router.post(
    '/application-templates',
    command(pool, {
      action: 'forms.template.create',
      entityType: 'application_template',
      idempotent: true,
      authorize: async (_client, ctx, req) => {
        const body = parseBody(CreateTemplateRequest, req.body);
        const tenderId = body.tenderId?.toLowerCase() ?? null;
        if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
        if (!canManage(ctx, tenderId)) throw forbidden(tenderId ? 'template.manage' : 'admin.templates', { entityType: 'application_template', tenderId: tenderId ?? undefined });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateTemplateRequest, req.body);
        const tenderId = body.tenderId?.toLowerCase() ?? null;
        const id = await createTemplate(client, { ownerKind: body.ownerKind, tenderId, name: body.name, isDemo: body.isDemo, userId: ctx.principal.userId });
        const t = (await getTemplate(client, id))!;
        return {
          status: 201,
          body: toTemplate(t, ctx),
          audit: [{ action: 'forms.template.create', entityType: 'application_template', entityId: id, tenderId, details: { ownerKind: body.ownerKind, isDemo: body.isDemo } }],
        };
      },
    }),
  );

  router.get(
    '/application-templates/:id',
    query(pool, 'forms.template.read', 'application_template', async (ctx, req, res) => {
      const t = await loadTemplate(pool, ctx, uuidParam(req, 'id', 'application_template'));
      res.json({ ...toTemplate(t, ctx), revisions: (await listTemplateRevisions(pool, t.id)).map((r) => toRevision(r, false)) });
    }),
  );

  router.post(
    '/application-templates/:id/revisions',
    command(pool, {
      action: 'forms.template_revision.create',
      entityType: 'template_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadTemplate(client, ctx, uuidParam(req, 'id', 'application_template'), true)),
      run: async (client, ctx, req) => {
        const t = await loadTemplate(client, ctx, uuidParam(req, 'id', 'application_template'), true);
        if (t.archived_at) throw conflict('шаблон в архиве', 'template_archived', { tenderId: t.tender_id ?? '', entityType: 'application_template', entityId: t.id });
        const body = parseBody(CreateTemplateRevisionRequest, req.body);
        const checked = validateSchema(body.schema);
        if (!checked.ok) throw new HttpError(400, 'VALIDATION_FAILED', 'схема полей не прошла проверку', { errors: checked.issues.slice(0, 100).map((i) => ({ path: i.path, message: i.message })) });
        if (body.sample && !(await client.query('SELECT 1 FROM blob WHERE sha256 = $1', [body.sample.sha256])).rowCount) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'образец формы не загружен');
        }
        // Размеченная копия образца (D-032 В-12-3): формат, теги и проверка по схеме — до записи; итог — в ревизии.
        let marked = null;
        if (body.markedSample) {
          if (!(await client.query('SELECT 1 FROM blob WHERE sha256 = $1', [body.markedSample.sha256])).rowCount) throw new HttpError(400, 'VALIDATION_FAILED', 'размеченный образец не загружен');
          const a = await analyzeMarkedSample(store, body.markedSample.sha256, checked.schema);
          marked = { sha256: body.markedSample.sha256, name: body.markedSample.name, format: a.format, markup: a.markup };
        }
        const id = await createTemplateRevision(client, {
          templateId: t.id,
          tenderId: t.tender_id,
          schema: checked.schema,
          sample: body.sample ?? null,
          marked,
          audience: body.audience ?? 'customer',
          userId: ctx.principal.userId,
        });
        const r = (await getTemplateRevision(client, id))!;
        return {
          status: 201,
          body: toRevision(r, true),
          etag: formatEtag(r.id, r.row_version),
          audit: [{ action: 'forms.template_revision.create', entityType: 'template_revision', entityId: id, tenderId: t.tender_id, details: { templateId: t.id, seq: r.seq, schemaSha256: r.schema_sha256 } }],
        };
      },
    }),
  );

  // Пробная проверка разметки без создания ревизии (для правки образца до загрузки).
  router.post(
    '/template-markup-check',
    query(pool, 'forms.markup.check', 'template_revision', async (ctx, req, res) => {
      const body = parseBody(MarkupCheckRequest, req.body);
      const tenderId = body.tenderId?.toLowerCase() ?? null;
      if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      if (!canManage(ctx, tenderId)) throw forbidden(tenderId ? 'template.manage' : 'admin.templates', { entityType: 'template_revision' });
      const checked = validateSchema(body.schema);
      if (!checked.ok) throw new HttpError(400, 'VALIDATION_FAILED', 'схема полей не прошла проверку', { errors: checked.issues.slice(0, 100).map((i) => ({ path: i.path, message: i.message })) });
      const a = await analyzeMarkedSample(store, body.markedSample.sha256, checked.schema);
      res.json({ outputFormat: a.format, markup: a.markup });
    }),
  );

  router.get(
    '/template-revisions/:id',
    query(pool, 'forms.template_revision.read', 'template_revision', async (ctx, req, res) => {
      const r = await loadRevision(pool, ctx, uuidParam(req, 'id', 'template_revision'));
      const prev = (await listTemplateRevisions(pool, r.template_id)).find((x) => x.id !== r.id && x.seq < r.seq && x.status !== 'draft') ?? null;
      res.json({ ...toRevision(r, true), previousRevisionId: prev?.id ?? null, diff: revisionDiff(prev?.field_schema ?? null, r.field_schema) });
    }),
  );

  router.post(
    '/template-revisions/:id/approve',
    command(pool, {
      action: 'forms.template_revision.approve',
      entityType: 'template_revision',
      authorize: async (client, ctx, req) => void (await loadRevision(client, ctx, uuidParam(req, 'id', 'template_revision'), true)),
      run: async (client, ctx, req) => {
        const r = await loadRevision(client, ctx, uuidParam(req, 'id', 'template_revision'), true, true);
        if (requireIfMatch(req, r.id) !== r.row_version) throw versionConflict({ rowVersion: r.row_version });
        const tgt = { tenderId: r.tender_id ?? '', entityType: 'template_revision', entityId: r.id };
        if (r.status !== 'draft') throw conflict('утвердить можно только черновик ревизии', 'revision_not_draft', tgt);
        // Размеченный образец с ошибками разметки не утверждается (D-032 В-12-3; вторая линия — 0032).
        if (r.markup && !r.markup.ok) throw conflict('в разметке образца есть ошибки: исправьте копию образца и загрузите новую ревизию', 'markup_invalid', tgt, { issues: r.markup.issues });
        const body = parseBody(ApproveTemplateRevisionRequest, req.body);
        const fragments = body.basisFragmentIds.map((f) => f.toLowerCase());
        if (r.tender_id && fragments.length === 0 && !body.basisDecisionId) {
          throw conflict('ревизия шаблона заказчика утверждается с основанием: документ, письмо или решение заказчика', 'basis_required', tgt);
        }
        const readable = await readableFragments(client, ctx, fragments);
        if (fragments.some((f) => !readable.has(f))) throw conflict('среди оснований есть фрагменты, которые вы не можете читать', 'restricted_fragments', tgt);
        await approveTemplateRevision(client, { revision: r, userId: ctx.principal.userId, basisFragmentIds: fragments, basisDecisionId: body.basisDecisionId?.toLowerCase() ?? null, basisNote: body.basisNote ?? null });
        const after = (await getTemplateRevision(client, r.id))!;
        return {
          status: 200,
          body: toRevision(after, false),
          etag: formatEtag(after.id, after.row_version),
          audit: [{ action: 'forms.template_revision.approve', entityType: 'template_revision', entityId: r.id, tenderId: r.tender_id, details: { templateId: r.template_id, seq: r.seq, basis: fragments.length + (body.basisDecisionId ? 1 : 0) } }],
        };
      },
    }),
  );

  router.post(
    '/template-revisions/:id/retire',
    command(pool, {
      action: 'forms.template_revision.retire',
      entityType: 'template_revision',
      authorize: async (client, ctx, req) => void (await loadRevision(client, ctx, uuidParam(req, 'id', 'template_revision'), true)),
      run: async (client, ctx, req) => {
        const r = await loadRevision(client, ctx, uuidParam(req, 'id', 'template_revision'), true, true);
        if (requireIfMatch(req, r.id) !== r.row_version) throw versionConflict({ rowVersion: r.row_version });
        if (r.status === 'retired') throw conflict('ревизия уже выведена', 'revision_retired', { tenderId: r.tender_id ?? '', entityType: 'template_revision', entityId: r.id });
        await retireTemplateRevision(client, r.id);
        const after = (await getTemplateRevision(client, r.id))!;
        return { status: 200, body: toRevision(after, false), etag: formatEtag(after.id, after.row_version), audit: [{ action: 'forms.template_revision.retire', entityType: 'template_revision', entityId: r.id, tenderId: r.tender_id, details: { seq: r.seq } }] };
      },
    }),
  );

  // Образец формы — файл ревизии (SHA); разметка для генерации — этап 12.
  router.post(
    '/form-samples',
    receiveUpload({
      pool,
      store,
      config,
      action: 'forms.sample.upload',
      entityType: 'blob',
      authorize: async (req) => {
        const ctx = requireCtx(req);
        const tenderId = tenderParam(req);
        if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
        if (!canManage(ctx, tenderId)) throw forbidden(tenderId ? 'template.manage' : 'admin.templates', { entityType: 'blob' });
      },
    }),
    command(pool, {
      action: 'forms.sample.upload',
      entityType: 'blob',
      idempotent: true,
      requestKey: (req) => `form-sample ${uploadName(req)} ${uploadedBlob(req)?.sha256 ?? ''}`,
      authorize: async (_client, ctx, req) => {
        const tenderId = tenderParam(req);
        if (!canManage(ctx, tenderId)) throw forbidden(tenderId ? 'template.manage' : 'admin.templates', { entityType: 'blob' });
      },
      run: async (client, _ctx, req) => {
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: 'application/octet-stream', storageKey: stored.storageKey });
        return {
          status: 201,
          body: { sha256: stored.sha256, name: uploadName(req), sizeBytes: stored.sizeBytes },
          audit: [{ action: 'forms.sample.upload', entityType: 'blob', entityId: null, tenderId: tenderParam(req), details: { sha256: stored.sha256, sizeBytes: stored.sizeBytes } }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Формулировки

  const canProposeWording = (ctx: IAccessContext, tenderId: string | null) => (tenderId === null ? hasContentRole(ctx.roles) : hasTenderCap(ctx, tenderId, 'application.fill'));
  const canApproveWording = (ctx: IAccessContext, tenderId: string | null) => (tenderId === null ? canApproveCompanyWording(ctx) : hasTenderCap(ctx, tenderId, 'template.manage'));
  const loadWordingVersion = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IWordingRow> => {
    const w = await getWordingVersion(db, id, lock);
    if (!w || !canReadTemplate(ctx, w.scope_tender_id)) throw notFound({ entityType: 'wording_version', entityId: id });
    return w;
  };

  router.get(
    '/approved-wordings',
    query(pool, 'forms.wording.list', 'wording', async (ctx, req, res) => {
      const q = parseBody(WordingsQuery, req.query);
      const tenderId = q.tenderId?.toLowerCase() ?? null;
      if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      if (!hasContentRole(ctx.roles) && !isTemplateAdmin(ctx)) throw forbidden('tender.read', { entityType: 'wording' });
      const rows = await listWordings(pool, ctx, { tenderId, query: q.q ?? null, tag: q.tag ?? null, status: q.status ?? null });
      res.json({ items: rows.map(toWording), canApproveCompany: canApproveCompanyWording(ctx) });
    }),
  );

  router.post(
    '/approved-wordings',
    command(pool, {
      action: 'forms.wording.propose',
      entityType: 'wording',
      idempotent: true,
      authorize: async (_client, ctx, req) => {
        const body = parseBody(CreateWordingRequest, req.body);
        const tenderId = body.scopeTenderId?.toLowerCase() ?? null;
        if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
        if (!canProposeWording(ctx, tenderId)) throw forbidden(tenderId ? 'application.fill' : 'tender.read', { entityType: 'wording' });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateWordingRequest, req.body);
        const tenderId = body.scopeTenderId?.toLowerCase() ?? null;
        const r = await createWording(client, { scopeTenderId: tenderId, title: body.title, text: body.text, tags: body.tags, userId: ctx.principal.userId });
        const w = (await getWordingVersion(client, r.versionId))!;
        return { status: 201, body: toWording(w), audit: [{ action: 'forms.wording.propose', entityType: 'wording', entityId: r.wordingId, tenderId, details: { version: 1, tags: body.tags } }] };
      },
    }),
  );

  router.get(
    '/approved-wordings/:id',
    query(pool, 'forms.wording.read', 'wording', async (ctx, req, res) => {
      const rows = await wordingHistory(pool, uuidParam(req, 'id', 'wording'));
      if (rows.length === 0 || !canReadTemplate(ctx, rows[0]!.scope_tender_id)) throw notFound({ entityType: 'wording', entityId: String(req.params.id ?? '') });
      res.json({ items: rows.map(toWording) });
    }),
  );

  router.post(
    '/approved-wordings/:id/versions',
    command(pool, {
      action: 'forms.wording.propose',
      entityType: 'wording',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const rows = await wordingHistory(client, uuidParam(req, 'id', 'wording'));
        if (rows.length === 0 || !canReadTemplate(ctx, rows[0]!.scope_tender_id)) throw notFound({ entityType: 'wording', entityId: String(req.params.id ?? '') });
        if (!canProposeWording(ctx, rows[0]!.scope_tender_id)) throw forbidden('application.fill', { entityType: 'wording' });
      },
      run: async (client, ctx, req) => {
        const wordingId = uuidParam(req, 'id', 'wording');
        const body = parseBody(AddWordingVersionRequest, req.body);
        const versionId = await addWordingVersion(client, { wordingId, text: body.text, tags: body.tags, userId: ctx.principal.userId });
        const w = (await getWordingVersion(client, versionId))!;
        return { status: 201, body: toWording(w), audit: [{ action: 'forms.wording.propose', entityType: 'wording', entityId: wordingId, tenderId: w.scope_tender_id, details: { version: w.version } }] };
      },
    }),
  );

  router.post(
    '/wording-versions/:id/decision',
    command(pool, {
      action: 'forms.wording.decide',
      entityType: 'wording_version',
      authorize: async (client, ctx, req) => {
        const w = await loadWordingVersion(client, ctx, uuidParam(req, 'id', 'wording_version'));
        if (!canApproveWording(ctx, w.scope_tender_id)) throw forbidden(w.scope_tender_id ? 'template.manage' : 'wording.approve', { entityType: 'wording_version', entityId: w.version_id });
      },
      run: async (client, ctx, req) => {
        const w = await loadWordingVersion(client, ctx, uuidParam(req, 'id', 'wording_version'), true);
        if (requireIfMatch(req, w.version_id) !== w.row_version) throw versionConflict({ rowVersion: w.row_version });
        const body = parseBody(DecideWordingRequest, req.body);
        const tgt = { tenderId: w.scope_tender_id ?? '', entityType: 'wording_version', entityId: w.version_id };
        if (w.status === 'retired' || (w.status === 'approved' && body.status === 'approved')) throw conflict('решение по этой версии уже принято', 'wording_decided', tgt);
        await decideWordingVersion(client, { versionId: w.version_id, wordingId: w.wording_id, status: body.status, userId: ctx.principal.userId });
        const after = (await getWordingVersion(client, w.version_id))!;
        return { status: 200, body: toWording(after), etag: formatEtag(after.version_id, after.row_version), audit: [{ action: 'forms.wording.decide', entityType: 'wording_version', entityId: w.version_id, tenderId: w.scope_tender_id, details: { status: body.status, version: w.version } }] };
      },
    }),
  );

  return router;
};
