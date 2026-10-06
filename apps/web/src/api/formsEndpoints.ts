// Вызовы приложений этапа 11 (portal-api §2.8 в редакции этапа 11). Значения проверяет сервер; клиент передаёт
// действие человека с If-Match по версии поля (второй редактор получает 412).
import { apiGet, apiPost, apiPut } from './client';
import type {
  IDraftBrief,
  IDraftView,
  IFieldSuggestion,
  IFieldVersion,
  IFieldView,
  IFormIssue,
  IStageIssues,
  ISuggestionRun,
  ITemplateBrief,
  ITemplateRevision,
  IWording,
  TFieldAction,
} from './formsTypes';

const enc = encodeURIComponent;

export const listTemplates = (tenderId: string | null, signal?: AbortSignal) =>
  apiGet<{ items: ITemplateBrief[]; canManageCompany: boolean; canApproveCompanyWording: boolean }>(`/application-templates${tenderId ? `?tenderId=${enc(tenderId)}` : ''}`, { signal });

export const getTemplate = (id: string, signal?: AbortSignal) => apiGet<ITemplateBrief & { revisions: ITemplateRevision[] }>(`/application-templates/${enc(id)}`, { signal });

export const createTemplate = (body: { ownerKind: 'company' | 'customer'; tenderId?: string | null; name: string; isDemo: boolean }, idempotencyKey: string) =>
  apiPost<ITemplateBrief>('/application-templates', { body, idempotencyKey });

export const createTemplateRevision = (templateId: string, schema: unknown, idempotencyKey: string) =>
  apiPost<ITemplateRevision>(`/application-templates/${enc(templateId)}/revisions`, { body: { schema }, idempotencyKey });

export const approveTemplateRevision = (r: ITemplateRevision, basisFragmentIds: string[]) =>
  apiPost<ITemplateRevision>(`/template-revisions/${enc(r.id)}/approve`, { body: { basisFragmentIds }, ifMatch: r.etag });

export const listWordings = (q: { tenderId?: string | null; query?: string; status?: string }, signal?: AbortSignal) => {
  const p = new URLSearchParams();
  if (q.tenderId) p.set('tenderId', q.tenderId);
  if (q.query) p.set('q', q.query);
  if (q.status) p.set('status', q.status);
  return apiGet<{ items: IWording[]; canApproveCompany: boolean }>(`/approved-wordings${p.size ? `?${p.toString()}` : ''}`, { signal });
};

export const proposeWording = (body: { scopeTenderId?: string | null; title: string; text: string; tags: string[] }, idempotencyKey: string) =>
  apiPost<IWording>('/approved-wordings', { body, idempotencyKey });

export const decideWording = (w: IWording, status: 'approved' | 'retired') => apiPost<IWording>(`/wording-versions/${enc(w.versionId)}/decision`, { body: { status }, ifMatch: w.etag });

export const listDrafts = (stageId: string, signal?: AbortSignal) => apiGet<{ items: IDraftBrief[]; canFill: boolean }>(`/stages/${enc(stageId)}/application-drafts`, { signal });

export const createDraft = (stageId: string, templateRevisionId: string, idempotencyKey: string) =>
  apiPost<IDraftView>(`/stages/${enc(stageId)}/application-drafts`, { body: { templateRevisionId }, idempotencyKey });

export const getDraft = (id: string, signal?: AbortSignal) => apiGet<IDraftView>(`/application-drafts/${enc(id)}`, { signal });

export const fieldAction = (draftId: string, field: IFieldView, body: TFieldAction) =>
  apiPut<{ draft: { id: string; status: string; etag: string; blocking: number; issues: IFormIssue[] }; field: IFieldView }>(`/application-drafts/${enc(draftId)}/fields/${enc(field.key)}`, {
    body,
    ifMatch: field.etag,
  });

export const fieldHistory = (draftId: string, key: string, signal?: AbortSignal) => apiGet<{ items: IFieldVersion[] }>(`/application-drafts/${enc(draftId)}/fields/${enc(key)}/history`, { signal });

export const completeDraft = (d: IDraftView) => apiPost<IDraftView>(`/application-drafts/${enc(d.id)}/complete`, { body: {}, ifMatch: d.etag });

export const migrateDraft = (d: IDraftView) => apiPost<IDraftView & { migration: unknown }>(`/application-drafts/${enc(d.id)}/migrate`, { body: {}, ifMatch: d.etag });

export const stageApplicationIssues = (stageId: string, signal?: AbortSignal) => apiGet<IStageIssues>(`/stages/${enc(stageId)}/application-issues`, { signal });

export const startSuggestionRun = (draftId: string, idempotencyKey: string) => apiPost<ISuggestionRun>(`/application-drafts/${enc(draftId)}/suggestion-runs`, { body: {}, idempotencyKey });

export const listSuggestionRuns = (draftId: string, signal?: AbortSignal) => apiGet<{ items: ISuggestionRun[] }>(`/application-drafts/${enc(draftId)}/suggestion-runs`, { signal });

export const decideFieldSuggestion = (s: IFieldSuggestion, decision: 'accept' | 'reject') =>
  apiPost<{ suggestion: { id: string; status: string } }>(`/field-suggestions/${enc(s.id)}/${decision}`, { body: {}, ifMatch: s.etag });
