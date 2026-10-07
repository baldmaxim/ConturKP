// Комплект-кандидат выпуска и библиотека стандартных вложений (этап 12; D-032; ADR-013; portal-api §2.9). Собирает
// участник тендера с candidate.create — только из входов, которые видит целиком; состав и файлы видит только тот, кто
// видит все закреплённые входы (права перепроверяются при каждом запросе; отзыв доступа закрывает собранные файлы).
// Чтение кандидата не пересобирает его. Файлы — по ID, не по пути; офисные — скачиванием, PDF — в песочнице CSP.
import { CandidateArchiveQuery, CreateCandidateRequest, CreateStandardAttachmentRequest, CreateStandardAttachmentRevisionRequest } from '@kontur/contracts';
import { detectFormat, MEDIA_TYPES } from '@kontur/adapters';
import { formatEtag, globalCapabilities, hasContentRole } from '@kontur/core';
import {
  approveStandardAttachmentRevision,
  auditFor,
  candidateFiles,
  candidateIsCurrent,
  createCandidate,
  createStandardAttachment,
  createStandardAttachmentRevision,
  fieldVersionVisibility,
  getCandidate,
  getCandidateFile,
  getDraft,
  getStandardAttachment,
  getStandardAttachmentRevision,
  listCandidates,
  listStandardAttachmentRevisions,
  lockTenderStages,
  plannedFieldVersionIds,
  writeAudit,
  type IAccessContext,
  type IDraftRow,
  type IStandardAttachmentRevisionRow,
  type Pool,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import PizZip from 'pizzip';
import { issuesForDraft } from '../formsView.ts';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { readStoredBlob } from '../releaseMarkup.ts';
import { CONTENT_CSP, contentDisposition } from './documents.ts';
import { candidateShell, candidateTarget, candidateView, candidateVisible, iso, loadCandidate, requireVisibleCandidate } from '../releaseViews.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';
import { loadStage } from './stages.ts';

const target = candidateTarget;

const attachmentView = (a: IStandardAttachmentRevisionRow, canManage: boolean) => ({
  revisionId: a.id,
  attachmentId: a.attachment_id,
  scopeTenderId: a.scope_tender_id,
  title: a.title,
  seq: a.seq,
  fileName: a.file_name,
  mediaType: a.media_type,
  sizeBytes: a.size_bytes,
  sha256: a.blob_sha256,
  audience: a.audience,
  status: a.status,
  createdAt: iso(a.created_at),
  approvedAt: iso(a.approved_at),
  etag: formatEtag(a.id, a.row_version),
  canManage,
});

export const releaseCandidatesRouter = (pool: Pool, store: BlobStore): Router => {
  const router = Router();
  const canManageAttachments = (ctx: IAccessContext, tenderId: string | null) =>
    tenderId === null ? globalCapabilities(ctx.roles).includes('admin.templates') : hasTenderCap(ctx, tenderId, 'template.manage');

  // ---------------------------------------------------------------- Кандидат

  router.post(
    '/stages/:id/release-candidates',
    command(pool, {
      action: 'release.candidate.create',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        if (!hasTenderCap(ctx, stage.tender_id, 'candidate.create')) throw forbidden('candidate.create', { entityType: 'tender_stage', entityId: stage.id, tenderId: stage.tender_id });
      },
      run: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        const body = parseBody(CreateCandidateRequest, req.body);
        const tgt = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        // Блокировка этапа — до проверок (R12-02): запись событий входов (новая редакция, правка поля) ждёт конца этой
        // транзакции, поэтому проверки ниже и закрепление видят одно состояние, а более позднее событие — после базы.
        await lockTenderStages(client, stage.tender_id, [stage.id]);
        // Собрать можно только из входов, которые создатель видит целиком (D-032 В-12-7).
        const drafts: IDraftRow[] = [];
        for (const id of body.draftIds.map((x) => x.toLowerCase())) {
          const d = await getDraft(client, id);
          if (!d || d.tender_id !== stage.tender_id) throw notFound({ entityType: 'application_draft', entityId: id });
          drafts.push(d);
        }
        const planned = await plannedFieldVersionIds(client, drafts);
        const visible = await fieldVersionVisibility(client, ctx, planned);
        if (planned.some((v) => !visible(v))) throw conflict('среди значений приложений есть то, что вы не можете читать: комплект не собирается', 'restricted_inputs', tgt);
        // Заполненность сейчас (проект §6 `fields_complete`; R12-02): тот же список незавершённых пунктов, что у «заполнено».
        for (const d of drafts.filter((x) => x.status === 'complete')) {
          const blocking = (await issuesForDraft(client, ctx, d)).issues.filter((x) => x.blocking);
          if (blocking.length > 0) {
            throw conflict(`приложение «${d.title}» больше не готово к комплекту: ${blocking[0]!.label} — ${blocking[0]!.message}`, 'drafts_not_complete', tgt, {
              draftId: d.id,
              issues: blocking.map((x) => ({ kind: x.kind, fieldKey: x.fieldKey, message: x.message })),
            });
          }
        }
        const r = await createCandidate(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          mode: body.mode,
          draftIds: drafts.map((d) => d.id),
          attachmentRevisionIds: body.attachmentRevisionIds.map((x) => x.toLowerCase()),
          userId: ctx.principal.userId,
        });
        if (!r.ok) {
          const text: Record<string, string> = {
            candidate_assembling: 'на этапе уже собирается комплект: дождитесь окончания сборки',
            no_calculation_revision: 'у этапа нет ревизии расчёта: выгрузите расчёт',
            no_scope: 'у этапа нет снимка области источников: зафиксируйте снимок',
            drafts_not_complete: 'в комплект входят только приложения в статусе «заполнено»',
            markup_missing: 'у ревизии шаблона приложения нет проверенной разметки образца',
            attachment_not_approved: 'вложение — утверждённая ревизия библиотеки компании или этого тендера',
            nothing_selected: 'выберите приложения или вложения комплекта',
          };
          throw conflict(text[r.reason] ?? r.reason, r.reason, tgt, r.detail ?? {});
        }
        const c = (await getCandidate(client, r.candidateId))!;
        return {
          status: 201,
          body: await candidateView(client, store, ctx, c),
          etag: formatEtag(c.id, c.row_version),
          audit: [{ action: 'release.candidate.create', entityType: 'release_candidate', entityId: c.id, tenderId: c.tender_id, details: { stageId: c.stage_id, seq: c.seq, mode: c.mode, drafts: drafts.length, attachments: body.attachmentRevisionIds.length } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/release-candidates',
    query(pool, 'release.candidate.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      if (!hasTenderCap(ctx, stage.tender_id, 'tender.read')) throw notFound({ entityType: 'tender_stage', entityId: stage.id });
      const items = [];
      for (const c of await listCandidates(pool, stage.id)) {
        items.push({ ...candidateShell(c), restricted: !(await candidateVisible(pool, ctx, c)), current: await candidateIsCurrent(pool, c), failureCode: c.failure_code });
      }
      res.json({ items, canCreate: hasTenderCap(ctx, stage.tender_id, 'candidate.create') });
    }),
  );

  router.get(
    '/release-candidates/:id',
    query(pool, 'release.candidate.read', 'release_candidate', async (ctx, req, res) => {
      const c = await loadCandidate(pool, ctx, uuidParam(req, 'id', 'release_candidate'));
      res.setHeader('ETag', formatEtag(c.id, c.row_version));
      res.json(await candidateView(pool, store, ctx, c));
    }),
  );

  router.get(
    '/release-candidates/:id/manifest',
    query(pool, 'release.candidate.manifest', 'release_candidate', async (ctx, req, res) => {
      const c = await loadCandidate(pool, ctx, uuidParam(req, 'id', 'release_candidate'));
      await requireVisibleCandidate(pool, ctx, c);
      if (!c.manifest_blob_sha256) throw conflict('манифест появляется у собранного комплекта', 'not_assembled', target(c));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-SHA256', c.manifest_blob_sha256);
      res.send(await readStoredBlob(store, c.manifest_blob_sha256));
    }),
  );

  // Точные байты файла — по ID; права и видимость входов — при каждом запросе (D-032 В-12-7).
  router.get(
    '/candidate-files/:id/content',
    query(pool, 'release.candidate.file.read', 'candidate_file', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'candidate_file');
      const f = await getCandidateFile(pool, id);
      if (!f) throw notFound({ entityType: 'candidate_file', entityId: id });
      const c = await loadCandidate(pool, ctx, f.candidate_id);
      await requireVisibleCandidate(pool, ctx, c);
      await writeAudit(pool, auditFor(ctx, { action: 'release.candidate.file.read', entityType: 'candidate_file', entityId: f.id, tenderId: c.tender_id, outcome: 'allowed', details: { candidateId: c.id, path: f.path, sha256: f.blob_sha256 } }));
      const inline = f.media_type === 'application/pdf';
      res.setHeader('Content-Type', inline ? 'application/pdf' : 'application/octet-stream');
      res.setHeader('Content-Length', String(f.size_bytes));
      res.setHeader('Content-Disposition', contentDisposition(inline, f.path));
      res.setHeader('Content-Security-Policy', CONTENT_CSP);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-SHA256', f.blob_sha256);
      const stream = store.openRead(f.blob_sha256);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  // ZIP комплекта: файлы для заказчика (или все с манифестом) из точных байтов кандидата; запись детерминированна.
  router.get(
    '/release-candidates/:id/archive',
    query(pool, 'release.candidate.archive', 'release_candidate', async (ctx, req, res) => {
      const c = await loadCandidate(pool, ctx, uuidParam(req, 'id', 'release_candidate'));
      await requireVisibleCandidate(pool, ctx, c);
      if (!c.manifest_blob_sha256) throw conflict('архив — у собранного комплекта', 'not_assembled', target(c));
      const q = CandidateArchiveQuery.safeParse(req.query);
      if (!q.success) throw new HttpError(400, 'VALIDATION_FAILED', 'set — customer или all');
      const files = (await candidateFiles(pool, c.id)).filter((f) => (q.data.set === 'all' ? true : f.audience === 'customer' && f.role !== 'preview'));
      const zip = new PizZip();
      const date = new Date(1980, 0, 1, 0, 0, 0);
      for (const f of files) zip.file(f.path, await readStoredBlob(store, f.blob_sha256), { date });
      if (q.data.set === 'all' && c.manifest_blob_sha256) zip.file('manifest.json', await readStoredBlob(store, c.manifest_blob_sha256), { date });
      const bytes = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      await writeAudit(pool, auditFor(ctx, { action: 'release.candidate.archive', entityType: 'release_candidate', entityId: c.id, tenderId: c.tender_id, outcome: 'allowed', details: { set: q.data.set, files: files.length } }));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Content-Disposition', contentDisposition(false, `Комплект ${c.seq}${q.data.set === 'all' ? ' (все файлы)' : ''}.zip`));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(bytes);
    }),
  );

  // ---------------------------------------------------------------- Стандартные вложения (В-12-4)

  router.get(
    '/standard-attachments',
    query(pool, 'release.attachment.list', 'standard_attachment', async (ctx, _req, res) => {
      if (!hasContentRole(ctx.roles)) throw forbidden('tender.read', { entityType: 'standard_attachment' });
      const tenders = [...ctx.memberships.keys()];
      const items = (await listStandardAttachmentRevisions(pool, tenders)).map((a) => attachmentView(a, canManageAttachments(ctx, a.scope_tender_id)));
      res.json({ items, canCreateCompany: canManageAttachments(ctx, null) });
    }),
  );

  router.post(
    '/standard-attachments',
    command(pool, {
      action: 'release.attachment.create',
      entityType: 'standard_attachment',
      idempotent: true,
      authorize: async (_client, ctx, req) => {
        const body = parseBody(CreateStandardAttachmentRequest, req.body);
        const tenderId = body.scopeTenderId?.toLowerCase() ?? null;
        if (tenderId && !hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
        if (!canManageAttachments(ctx, tenderId)) throw forbidden(tenderId ? 'template.manage' : 'admin.templates', { entityType: 'standard_attachment' });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateStandardAttachmentRequest, req.body);
        const id = await createStandardAttachment(client, { scopeTenderId: body.scopeTenderId?.toLowerCase() ?? null, title: body.title, userId: ctx.principal.userId });
        return {
          status: 201,
          body: { id, title: body.title, scopeTenderId: body.scopeTenderId ?? null },
          audit: [{ action: 'release.attachment.create', entityType: 'standard_attachment', entityId: id, tenderId: body.scopeTenderId ?? null, details: { title: body.title } }],
        };
      },
    }),
  );

  router.post(
    '/standard-attachments/:id/revisions',
    command(pool, {
      action: 'release.attachment.revision.create',
      entityType: 'standard_attachment_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const a = await getStandardAttachment(client, uuidParam(req, 'id', 'standard_attachment'));
        if (!a || (a.scope_tender_id && !hasTenderCap(ctx, a.scope_tender_id, 'tender.read'))) throw notFound({ entityType: 'standard_attachment' });
        if (!canManageAttachments(ctx, a.scope_tender_id)) throw forbidden(a.scope_tender_id ? 'template.manage' : 'admin.templates', { entityType: 'standard_attachment', entityId: a.id });
      },
      run: async (client, ctx, req) => {
        const a = (await getStandardAttachment(client, uuidParam(req, 'id', 'standard_attachment')))!;
        const body = parseBody(CreateStandardAttachmentRevisionRequest, req.body);
        if (!(await client.query('SELECT 1 FROM blob WHERE sha256 = $1', [body.sha256])).rowCount || !(await store.exists(body.sha256))) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'файл вложения не загружен');
        }
        // Формат по содержимому (ADR-013): DOCX, XLSX, DOC или PDF — «как есть».
        const format = detectFormat(await readStoredBlob(store, body.sha256));
        if (!format) throw new HttpError(400, 'VALIDATION_FAILED', 'вложение — DOCX, XLSX, DOC или PDF (ADR-013)');
        const id = await createStandardAttachmentRevision(client, { attachmentId: a.id, blobSha256: body.sha256, fileName: body.fileName, mediaType: MEDIA_TYPES[format], audience: body.audience, userId: ctx.principal.userId });
        const rev = (await getStandardAttachmentRevision(client, id))!;
        return {
          status: 201,
          body: attachmentView(rev, true),
          etag: formatEtag(rev.id, rev.row_version),
          audit: [{ action: 'release.attachment.revision.create', entityType: 'standard_attachment_revision', entityId: id, tenderId: a.scope_tender_id, details: { attachmentId: a.id, seq: rev.seq, sha256: body.sha256 } }],
        };
      },
    }),
  );

  router.post(
    '/standard-attachment-revisions/:id/approve',
    command(pool, {
      action: 'release.attachment.revision.approve',
      entityType: 'standard_attachment_revision',
      authorize: async (client, ctx, req) => {
        const r = await getStandardAttachmentRevision(client, uuidParam(req, 'id', 'standard_attachment_revision'));
        if (!r || (r.scope_tender_id && !hasTenderCap(ctx, r.scope_tender_id, 'tender.read'))) throw notFound({ entityType: 'standard_attachment_revision' });
        if (!canManageAttachments(ctx, r.scope_tender_id)) throw forbidden(r.scope_tender_id ? 'template.manage' : 'admin.templates', { entityType: 'standard_attachment_revision', entityId: r.id });
      },
      run: async (client, ctx, req) => {
        const r = (await getStandardAttachmentRevision(client, uuidParam(req, 'id', 'standard_attachment_revision'), true))!;
        if (requireIfMatch(req, r.id) !== r.row_version) throw versionConflict({ rowVersion: r.row_version });
        if (r.status !== 'draft') throw conflict('утвердить можно только черновик ревизии вложения', 'revision_not_draft', { tenderId: r.scope_tender_id ?? '', entityType: 'standard_attachment_revision', entityId: r.id });
        await approveStandardAttachmentRevision(client, r, ctx.principal.userId);
        const after = (await getStandardAttachmentRevision(client, r.id))!;
        return {
          status: 200,
          body: attachmentView(after, true),
          etag: formatEtag(after.id, after.row_version),
          audit: [{ action: 'release.attachment.revision.approve', entityType: 'standard_attachment_revision', entityId: r.id, tenderId: r.scope_tender_id, details: { attachmentId: r.attachment_id, seq: r.seq } }],
        };
      },
    }),
  );

  return router;
};
