// Документы договора (T06A-2, D-023; portal-api §2.6): основной договор, допсоглашения, приложения —
// общая модель document/document_revision с contract_id. Загружает пользователь с contract.read и
// contract.manage; .docx и сканы хранятся, но не распознаются (D-022 OD-4). Повтор того же файла
// даёт существующую редакцию, другое содержимое с тем же именем — новую редакцию (имя не идентичность).
import type { IAppConfig } from '@kontur/config';
import { ContractDocumentUploadQuery, PatchContractDocumentRequest } from '@kontur/contracts';
import { classifyFile, formatEtag } from '@kontur/core';
import {
  contractCandidates,
  getContractDocument,
  insertBlob,
  listContractDocuments,
  listRevisions,
  registerContractFile,
  setDocumentRecognitionRoute,
  updateContractDocumentTitle,
  type ContractRegistration,
  type ContractUploadTarget,
  type IAccessContext,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import type { Request } from 'express';
import { Router } from 'express';
import { toContractDocument, toContractRevision } from '../contractMappers.ts';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadName, uploadedBlob } from '../http/upload.ts';
import { requireContractCap } from './contractScope.ts';
import { loadContract } from './contracts.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

const target = (contractId: string, entityId: string | null = null) => ({ entityType: 'contract', entityId: entityId ?? contractId, details: { contractId } });

// Документ договора — только с contract.read; иначе 404 (существование документа не раскрывается).
const loadDocument = async (db: PoolClient | Pool, ctx: IAccessContext, id: string) => {
  const d = await getContractDocument(db, ctx, id);
  if (!d) throw notFound({ entityType: 'document', entityId: id });
  return d;
};

// Загрузка меняет содержимое договора: чтение и ведение одновременно (OD-2).
const requireUploadRights = (ctx: IAccessContext, contractId: string): void => {
  requireContractCap(ctx, contractId, 'contract.read', target(contractId));
  requireContractCap(ctx, contractId, 'contract.manage', target(contractId));
};

const uploadAuthorize = (contractOf: (req: Request, ctx: IAccessContext) => Promise<string>) => async (req: Request) => {
  const ctx = requireCtx(req);
  requireUploadRights(ctx, await contractOf(req, ctx));
};

const statusOf = (r: ContractRegistration, contractId: string): number => {
  if (r.status === 'registered') return 201;
  if (r.status === 'duplicate') return 200;
  if (r.status === 'document_not_found') throw notFound({ entityType: 'document', details: { contractId } });
  const message = {
    content_in_other_document: 'такое содержимое уже есть в договоре другим документом',
    main_document_exists: 'у договора уже есть основной документ: новая версия — новая редакция основного документа',
    main_document_missing: 'допсоглашение и приложение ссылаются на основной документ этого договора',
  }[r.status];
  throw new HttpError(409, 'STATE_CONFLICT', message, { current: { reason: r.status, ...('documentId' in r ? { documentId: r.documentId } : {}) } }, target(contractId));
};

export const contractDocumentsRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  // Общий шаг двух загрузок: файл принят хранилищем до транзакции, в транзакции — блокировка договора,
  // проверка типа, регистрация редакции и аудит. Имя файла и название документа в журнал не пишутся: события
// договора видит журнал администратора, а содержимого договора он не видит (D-022 OD-2).
  const register = async (client: PoolClient, ctx: IAccessContext, req: Request, contractId: string, targetOf: () => ContractUploadTarget) => {
    const stored = uploadedBlob(req);
    if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
    const name = uploadName(req);
    const c = await loadContract(client, ctx, contractId, true);
    requireUploadRights(ctx, c.id);
    if (c.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'договор в архиве: документы не загружаются', {}, target(c.id));
    const verdict = classifyFile(name, stored.head, stored.sizeBytes);
    if (verdict.kind !== 'document') {
      const detail = verdict.kind === 'archive' ? 'архив не принимается: загрузите документ отдельным файлом' : verdict.detail;
      throw new HttpError(400, 'VALIDATION_FAILED', detail, {}, target(c.id));
    }
    await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: verdict.mediaType, storageKey: stored.storageKey });
    const t = targetOf();
    const r = await registerContractFile(client, ctx, { contractId: c.id, target: t, blobSha256: stored.sha256, observedName: name });
    const status = statusOf(r, c.id);
    const reg = r as Extract<ContractRegistration, { status: 'registered' | 'duplicate' }>;
    const document = await loadDocument(client, ctx, reg.documentId);
    return {
      status,
      body: { status: reg.status, documentId: reg.documentId, revisionId: reg.revisionId, revisionSeq: reg.revisionSeq, document: toContractDocument(document) },
      etag: formatEtag(document.id, document.row_version),
      audit: [
        {
          action: 'contract.document.upload',
          entityType: 'document_revision',
          entityId: reg.revisionId,
          details: {
            contractId: c.id,
            documentId: reg.documentId,
            role: document.contract_role,
            status: reg.status,
            newDocument: reg.status === 'registered' && reg.newDocument,
            sha256: stored.sha256,
            sizeBytes: stored.sizeBytes,
            mediaType: verdict.mediaType,
          },
        },
      ],
    };
  };

  router.get(
    '/contracts/:id/documents',
    query(pool, 'contract.document.list', 'contract', async (ctx, req, res) => {
      const c = await loadContract(pool, ctx, uuidParam(req, 'id', 'contract'));
      requireContractCap(ctx, c.id, 'contract.read', target(c.id));
      res.json({ items: (await listContractDocuments(pool, c.id)).map(toContractDocument) });
    }),
  );

  router.post(
    '/contracts/:id/documents',
    receiveUpload({
      pool,
      store,
      config,
      action: 'contract.document.upload',
      entityType: 'contract',
      authorize: uploadAuthorize(async (req, ctx) => (await loadContract(pool, ctx, uuidParam(req, 'id', 'contract'))).id),
    }),
    command(pool, {
      action: 'contract.document.upload',
      entityType: 'contract',
      idempotent: true,
      requestKey: (req) => `contract-document ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''} ${JSON.stringify(req.query)}`,
      authorize: async (client, ctx, req) => requireUploadRights(ctx, (await loadContract(client, ctx, uuidParam(req, 'id', 'contract'))).id),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract');
        const q = parseBody(ContractDocumentUploadQuery, req.query);
        return register(client, ctx, req, id, () => ({
          kind: 'document',
          role: q.role,
          mainDocumentId: q.mainDocumentId ?? null,
          title: q.title ?? uploadName(req),
        }));
      },
    }),
  );

  router.get(
    '/contract-documents/:id',
    query(pool, 'contract.document.read', 'document', async (ctx, req, res) => {
      const d = await loadDocument(pool, ctx, uuidParam(req, 'id', 'document'));
      res.setHeader('ETag', formatEtag(d.id, d.row_version));
      res.json({ ...toContractDocument(d), revisionList: (await listRevisions(pool, d.id)).map(toContractRevision) });
    }),
  );

  router.patch(
    '/contract-documents/:id',
    command(pool, {
      action: 'contract.document.update',
      entityType: 'document',
      authorize: async (client, ctx, req) => {
        const d = await loadDocument(client, ctx, uuidParam(req, 'id', 'document'));
        requireContractCap(ctx, d.contract_id, 'contract.manage', target(d.contract_id, d.id));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document');
        const probe = await loadDocument(client, ctx, id);
        await loadContract(client, ctx, probe.contract_id, true);
        const d = await loadDocument(client, ctx, id);
        requireContractCap(ctx, d.contract_id, 'contract.manage', target(d.contract_id, d.id));
        if (requireIfMatch(req, id) !== d.row_version) throw versionConflict(toContractDocument(d));
        const { title, recognitionRoute } = parseBody(PatchContractDocumentRequest, req.body);
        if (title !== undefined) await updateContractDocumentTitle(client, id, title);
        if (recognitionRoute !== undefined && recognitionRoute !== d.recognition_route) await setDocumentRecognitionRoute(client, id, recognitionRoute);
        const after = await loadDocument(client, ctx, id);
        // Название — содержательное поле: в журнал только признак; политика маршрута содержимым не является.
        const changes: Record<string, unknown> = {};
        if (title !== undefined) changes.title = { changed: true };
        if (after.recognition_route !== d.recognition_route) changes.recognitionRoute = { from: d.recognition_route, to: after.recognition_route };
        return {
          status: 200,
          body: toContractDocument(after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'contract.document.update', entityType: 'document', entityId: id, details: { contractId: d.contract_id, changes } }],
        };
      },
    }),
  );

  // Новая версия файла документа — новая редакция; прежняя не меняется и остаётся в снимках (T06A-1).
  router.post(
    '/contract-documents/:id/revisions',
    receiveUpload({
      pool,
      store,
      config,
      action: 'contract.document.upload',
      entityType: 'document',
      authorize: uploadAuthorize(async (req, ctx) => (await loadDocument(pool, ctx, uuidParam(req, 'id', 'document'))).contract_id),
    }),
    command(pool, {
      action: 'contract.document.upload',
      entityType: 'document',
      idempotent: true,
      requestKey: (req) => `contract-revision ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''}`,
      authorize: async (client, ctx, req) => requireUploadRights(ctx, (await loadDocument(client, ctx, uuidParam(req, 'id', 'document'))).contract_id),
      run: async (client, ctx, req) => {
        const documentId = uuidParam(req, 'id', 'document');
        const d = await loadDocument(client, ctx, documentId);
        return register(client, ctx, req, d.contract_id, () => ({ kind: 'revision', documentId }));
      },
    }),
  );

  // Кандидаты в состав этапа (D-017, ADR-008 §10): последние редакции документов договоров, действующе
  // связанных с тендером этапа и читаемых пользователем. Это предложение, а не область поиска.
  router.get(
    '/stages/:id/contract-candidates',
    query(pool, 'source.contract.candidates', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      requireTenderCapById(ctx, stage.tender_id, 'tender.read', { entityType: 'tender_stage', entityId: stage.id });
      const rows = await contractCandidates(pool, ctx, stage.tender_id);
      res.json({
        items: rows.map((r) => ({
          contractId: r.contract_id,
          contractNumber: r.contract_number,
          contractTitle: r.contract_title,
          documentId: r.document_id,
          documentTitle: r.document_title,
          role: r.contract_role,
          documentRevisionId: r.document_revision_id,
          revisionSeq: r.revision_seq,
          runStatus: r.run_status,
        })),
      });
    }),
  );

  return router;
};
