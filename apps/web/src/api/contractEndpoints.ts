// Вызовы договорного контура (этап 06a; portal-api §2.6).
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, etagOf } from './client';
import type {
  IContract,
  IContractCandidate,
  IContractCreateInput,
  IContractDocument,
  IContractDocumentDetail,
  IContractGrants,
  IContractLink,
  IContractList,
  IContractPatch,
  TContractCapability,
} from './contractTypes';
import type { IListResponse, ISearchRun } from './types';

const enc = encodeURIComponent;

export const listContracts = (signal?: AbortSignal): Promise<IContractList> => apiGet<IContractList>('/contracts', { signal });

export const createContract = (input: IContractCreateInput, idempotencyKey: string): Promise<IContract> =>
  apiPost<IContract>('/contracts', { body: input, idempotencyKey });

export const getContract = (id: string, signal?: AbortSignal): Promise<IContract> => apiGet<IContract>(`/contracts/${enc(id)}`, { signal });

export const updateContract = (id: string, rowVersion: number, patch: IContractPatch): Promise<IContract> =>
  apiPatch<IContract>(`/contracts/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

export const setContractArchived = (id: string, rowVersion: number, archived: boolean): Promise<IContract> =>
  apiPost<IContract>(`/contracts/${enc(id)}/${archived ? 'archive' : 'restore'}`, { body: {}, ifMatch: etagOf(id, rowVersion) });

// Строки доступа (администратор договоров; If-Match — ETag договора)
export const listContractAccess = (id: string, signal?: AbortSignal): Promise<IContractGrants> =>
  apiGet<IContractGrants>(`/contracts/${enc(id)}/access`, { signal });

export const putContractAccess = (id: string, rowVersion: number, userId: string, capabilities: TContractCapability[]): Promise<IContractGrants> =>
  apiPut<IContractGrants>(`/contracts/${enc(id)}/access/${enc(userId)}`, { body: { capabilities }, ifMatch: etagOf(id, rowVersion) });

export const listContractCreators = (signal?: AbortSignal): Promise<IContractGrants> => apiGet<IContractGrants>('/admin/contract-creators', { signal });

export const setContractCreator = (userId: string, granted: boolean): Promise<IContractGrants> =>
  granted ? apiPut<IContractGrants>(`/admin/contract-creators/${enc(userId)}`, { body: {} }) : apiDelete<IContractGrants>(`/admin/contract-creators/${enc(userId)}`);

// Связи договора с тендером
export const listContractLinks = (contractId: string, signal?: AbortSignal): Promise<IListResponse<IContractLink>> =>
  apiGet<IListResponse<IContractLink>>(`/contracts/${enc(contractId)}/tenders`, { signal });

export const createContractLink = (
  contractId: string,
  input: { tenderId: string; stageId?: string | null; note?: string | null },
  idempotencyKey: string,
): Promise<IContractLink> => apiPost<IContractLink>(`/contracts/${enc(contractId)}/tenders`, { body: input, idempotencyKey });

export const updateContractLink = (link: IContractLink, patch: { stageId?: string | null; note?: string | null }): Promise<IContractLink> =>
  apiPatch<IContractLink>(`/contract-tender-links/${enc(link.id)}`, { body: patch, ifMatch: etagOf(link.id, link.rowVersion) });

export const archiveContractLink = (link: IContractLink, reason: string): Promise<IContractLink> =>
  apiPost<IContractLink>(`/contract-tender-links/${enc(link.id)}/archive`, { body: { reason }, ifMatch: etagOf(link.id, link.rowVersion) });

export const listTenderContracts = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<IContractLink>> =>
  apiGet<IListResponse<IContractLink>>(`/tenders/${enc(tenderId)}/contracts`, { signal });

// Документы договора
export const listContractDocuments = (contractId: string, signal?: AbortSignal): Promise<IListResponse<IContractDocument>> =>
  apiGet<IListResponse<IContractDocument>>(`/contracts/${enc(contractId)}/documents`, { signal });

export const getContractDocument = (id: string, signal?: AbortSignal): Promise<IContractDocumentDetail> =>
  apiGet<IContractDocumentDetail>(`/contract-documents/${enc(id)}`, { signal });

export const renameContractDocument = (doc: IContractDocument, title: string): Promise<IContractDocument> =>
  apiPatch<IContractDocument>(`/contract-documents/${enc(doc.id)}`, { body: { title }, ifMatch: etagOf(doc.id, doc.rowVersion) });

/** Политика маршрута распознавания PDF документа договора (этап 05a, OD-1). */
export const setContractDocumentRoute = (doc: IContractDocument, recognitionRoute: 'auto' | 'local' | 'rdweb'): Promise<IContractDocument> =>
  apiPatch<IContractDocument>(`/contract-documents/${enc(doc.id)}`, { body: { recognitionRoute }, ifMatch: etagOf(doc.id, doc.rowVersion) });

// Кандидаты из действующе связанных договоров в состав этапа
export const listContractCandidates = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IContractCandidate>> =>
  apiGet<IListResponse<IContractCandidate>>(`/stages/${enc(stageId)}/contract-candidates`, { signal });

// Поиск в контексте договора (ADR-012 §24): текущий корпус договора.
export const runContractSearch = (contractId: string, query: string, limit = 20): Promise<ISearchRun> =>
  apiPost<ISearchRun>('/search', { body: { context: { kind: 'contract', contractId }, query, limit } });
