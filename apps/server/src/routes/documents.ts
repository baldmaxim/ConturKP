// Документы, редакции, выдача оригинала по правам, события барьера этапа (portal-api §2.3).
import { PatchDocumentRequest } from '@kontur/contracts';
import { formatEtag } from '@kontur/core';
import {
  getDocument,
  getRevision,
  listDocuments,
  listOccurrences,
  listRevisions,
  listStageEvents,
  updateDocument,
  type Pool,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { notFound } from '../http/errors.ts';
import { toDocument, toRevision, toStageEvent } from '../sourceMappers.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

// Оригинал отдаётся как есть, но без исполнения активного содержимого (A38): песочница CSP без
// скриптов и сетевых запросов, nosniff; HTML, письма, XML и офисные файлы — только скачиванием.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/bmp', 'text/plain', 'text/csv']);
const CONTENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

const contentDisposition = (inline: boolean, name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

export const documentsRouter = (pool: Pool, store: BlobStore): Router => {
  const router = Router();

  router.get(
    '/stages/:id/documents',
    query(pool, 'source.document.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      res.json({ items: (await listDocuments(pool, ctx, stage.tender_id)).map(toDocument) });
    }),
  );

  router.get(
    '/documents/:id',
    query(pool, 'source.document.read', 'document', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'document');
      const d = await getDocument(pool, ctx, id);
      if (!d) throw notFound({ entityType: 'document', entityId: id });
      const revisions = await listRevisions(pool, id);
      const occurrences = await listOccurrences(pool, revisions.map((r) => r.id));
      res.setHeader('ETag', formatEtag(id, d.row_version));
      res.json({ ...toDocument(d), revisionList: revisions.map((r) => toRevision(r, occurrences)) });
    }),
  );

  router.patch(
    '/documents/:id',
    command(pool, {
      action: 'source.document.update',
      entityType: 'document',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document');
        const d = await getDocument(client, ctx, id);
        if (!d) throw notFound({ entityType: 'document', entityId: id });
        requireTenderCapById(ctx, d.tender_id, 'source.write', { entityType: 'document', entityId: id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document');
        const d = (await getDocument(client, ctx, id, true))!;
        if (requireIfMatch(req, id) !== d.row_version) throw versionConflict(toDocument(d));
        const body = parseBody(PatchDocumentRequest, req.body);
        await updateDocument(client, id, body);
        const after = (await getDocument(client, ctx, id))!;
        const changes: Record<string, unknown> = {};
        for (const [k, before, now] of [
          ['title', d.title, after.title],
          ['docType', d.doc_type, after.doc_type],
          ['docCode', d.doc_code, after.doc_code],
          ['scopeNote', d.scope_note, after.scope_note],
        ] as const) {
          if (before !== now) changes[k] = { from: before, to: now };
        }
        return {
          status: 200,
          body: toDocument(after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'source.document.update', entityType: 'document', entityId: id, tenderId: d.tender_id, details: { changes } }],
        };
      },
    }),
  );

  router.get(
    '/document-revisions/:id/content',
    query(pool, 'source.content.read', 'document_revision', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'document_revision');
      const r = await getRevision(pool, ctx, id);
      if (!r) throw notFound({ entityType: 'document_revision', entityId: id });
      const occ = await listOccurrences(pool, [id]);
      const name = occ.at(-1)?.observed_name ?? `revision-${r.revision_seq}`;
      const inline = INLINE_TYPES.has(r.media_type);
      res.setHeader('Content-Type', inline ? r.media_type : 'application/octet-stream');
      res.setHeader('Content-Length', String(r.size_bytes));
      res.setHeader('Content-Disposition', contentDisposition(inline, name));
      res.setHeader('Content-Security-Policy', CONTENT_CSP);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-SHA256', r.blob_sha256);
      const stream = store.openRead(r.blob_sha256);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  router.get(
    '/stages/:id/input-events',
    query(pool, 'stage.events.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      res.json({ inputVersion: stage.input_version, items: (await listStageEvents(pool, stage.id, 200)).map(toStageEvent) });
    }),
  );

  return router;
};
