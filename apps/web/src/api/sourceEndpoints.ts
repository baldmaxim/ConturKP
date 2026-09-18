// Вызовы API источников этапа 03: партии импорта, документы, состав источников, каналы поступления.
import { API_BASE, apiGet, apiPatch, apiPost, apiPut, etagOf } from './client';
import type {
  IDocument,
  IDocumentDetail,
  IDocumentPatch,
  IImportBatch,
  IImportBatchDetail,
  IImportItem,
  IIntakeChannel,
  IIntakeChannelCreateInput,
  IIntakeChannelPatch,
  IListResponse,
  IScanAccepted,
  ISourceSet,
  ISourceSetItemInput,
  ISourceSetRevision,
  IStageInputEvents,
  TResolveItemInput,
} from './types';

const enc = encodeURIComponent;

// Партии импорта
export const listImports = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IImportBatch>> =>
  apiGet<IListResponse<IImportBatch>>(`/stages/${enc(stageId)}/imports`, { signal });

export const getImport = (id: string, signal?: AbortSignal): Promise<IImportBatchDetail> =>
  apiGet<IImportBatchDetail>(`/imports/${enc(id)}`, { signal });

export const resolveImportItem = (
  itemId: string,
  rowVersion: number,
  input: TResolveItemInput,
  idempotencyKey: string,
): Promise<IImportItem> =>
  apiPost<IImportItem>(`/import-items/${enc(itemId)}/resolve`, {
    body: input,
    ifMatch: etagOf(itemId, rowVersion),
    idempotencyKey,
  });

// Документы
export const listDocuments = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IDocument>> =>
  apiGet<IListResponse<IDocument>>(`/stages/${enc(stageId)}/documents`, { signal });

export const getDocument = (id: string, signal?: AbortSignal): Promise<IDocumentDetail> =>
  apiGet<IDocumentDetail>(`/documents/${enc(id)}`, { signal });

export const updateDocument = (id: string, rowVersion: number, patch: IDocumentPatch): Promise<IDocument> =>
  apiPatch<IDocument>(`/documents/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

/** Адрес оригинала редакции: обычная ссылка, сервер сам решает inline или attachment. */
export const revisionContentUrl = (revisionId: string): string =>
  `${API_BASE}/document-revisions/${enc(revisionId)}/content`;

// Состав источников
export const listSourceSets = (stageId: string, signal?: AbortSignal): Promise<IListResponse<ISourceSet>> =>
  apiGet<IListResponse<ISourceSet>>(`/stages/${enc(stageId)}/source-sets`, { signal });

export const createSourceSetDraft = (stageId: string, idempotencyKey: string): Promise<ISourceSetRevision> =>
  apiPost<ISourceSetRevision>(`/stages/${enc(stageId)}/source-set-revisions`, { body: {}, idempotencyKey });

export const replaceSourceSetItems = (
  revisionId: string,
  rowVersion: number,
  items: ISourceSetItemInput[],
): Promise<ISourceSetRevision> =>
  apiPut<ISourceSetRevision>(`/source-set-revisions/${enc(revisionId)}/items`, {
    body: { items },
    ifMatch: etagOf(revisionId, rowVersion),
  });

export const listInputEvents = (stageId: string, signal?: AbortSignal): Promise<IStageInputEvents> =>
  apiGet<IStageInputEvents>(`/stages/${enc(stageId)}/input-events`, { signal });

// Каналы поступления
export const listIntakeChannels = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<IIntakeChannel>> =>
  apiGet<IListResponse<IIntakeChannel>>(`/tenders/${enc(tenderId)}/intake-channels`, { signal });

export const createIntakeChannel = (
  tenderId: string,
  input: IIntakeChannelCreateInput,
  idempotencyKey: string,
): Promise<IIntakeChannel> =>
  apiPost<IIntakeChannel>(`/tenders/${enc(tenderId)}/intake-channels`, { body: input, idempotencyKey });

export const updateIntakeChannel = (id: string, rowVersion: number, patch: IIntakeChannelPatch): Promise<IIntakeChannel> =>
  apiPatch<IIntakeChannel>(`/intake-channels/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

export const scanIntakeChannel = (id: string): Promise<IScanAccepted> =>
  apiPost<IScanAccepted>(`/intake-channels/${enc(id)}/scan`);
