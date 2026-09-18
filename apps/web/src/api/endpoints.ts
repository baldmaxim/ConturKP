import { apiDelete, apiGet, apiPatch, apiPost, apiPut, etagOf } from './client';
import type {
  IAuditPage,
  IListResponse,
  IMe,
  IMembersResponse,
  IStage,
  IStageCreateInput,
  IStagePatch,
  ITender,
  ITenderCreateInput,
  ITenderPatch,
  IUser,
  IUserCreateInput,
  IUserPatch,
  TMemberRole,
} from './types';

const enc = encodeURIComponent;

const pageQuery = (cursor: string | null, limit: number): string => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  }
  return params.toString();
};

// Сеанс
export const login = (loginName: string, password: string): Promise<IMe> =>
  apiPost<IMe>('/auth/login', { body: { login: loginName, password }, skipAuthRedirect: true });

export const logout = (): Promise<void> => apiPost<void>('/auth/logout', { skipAuthRedirect: true });

export const getMe = (signal?: AbortSignal): Promise<IMe> => apiGet<IMe>('/me', { signal, skipAuthRedirect: true });

export const changeMyPassword = (currentPassword: string, newPassword: string): Promise<void> =>
  apiPost<void>('/me/password', { body: { currentPassword, newPassword } });

// Тендеры
export const listTenders = (signal?: AbortSignal): Promise<IListResponse<ITender>> =>
  apiGet<IListResponse<ITender>>('/tenders', { signal });

export const createTender = (input: ITenderCreateInput, idempotencyKey: string): Promise<ITender> =>
  apiPost<ITender>('/tenders', { body: input, idempotencyKey });

export const getTender = (id: string, signal?: AbortSignal): Promise<ITender> =>
  apiGet<ITender>(`/tenders/${enc(id)}`, { signal });

export const updateTender = (id: string, rowVersion: number, patch: ITenderPatch): Promise<ITender> =>
  apiPatch<ITender>(`/tenders/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

// Участники тендера (If-Match — ETag тендера)
export const listMembers = (tenderId: string, signal?: AbortSignal): Promise<IMembersResponse> =>
  apiGet<IMembersResponse>(`/tenders/${enc(tenderId)}/members`, { signal });

export const putMember = (
  tenderId: string,
  tenderRowVersion: number,
  userId: string,
  memberRole: TMemberRole,
): Promise<IMembersResponse> =>
  apiPut<IMembersResponse>(`/tenders/${enc(tenderId)}/members/${enc(userId)}`, {
    body: { memberRole },
    ifMatch: etagOf(tenderId, tenderRowVersion),
  });

export const deleteMember = (tenderId: string, tenderRowVersion: number, userId: string): Promise<IMembersResponse> =>
  apiDelete<IMembersResponse>(`/tenders/${enc(tenderId)}/members/${enc(userId)}`, {
    ifMatch: etagOf(tenderId, tenderRowVersion),
  });

// Этапы
export const listStages = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<IStage>> =>
  apiGet<IListResponse<IStage>>(`/tenders/${enc(tenderId)}/stages`, { signal });

export const createStage = (tenderId: string, input: IStageCreateInput, idempotencyKey: string): Promise<IStage> =>
  apiPost<IStage>(`/tenders/${enc(tenderId)}/stages`, { body: input, idempotencyKey });

export const getStage = (id: string, signal?: AbortSignal): Promise<IStage> =>
  apiGet<IStage>(`/stages/${enc(id)}`, { signal });

export const updateStage = (id: string, rowVersion: number, patch: IStagePatch): Promise<IStage> =>
  apiPatch<IStage>(`/stages/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

// Журнал
export const listTenderAudit = (
  tenderId: string,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<IAuditPage> => apiGet<IAuditPage>(`/tenders/${enc(tenderId)}/audit-events?${pageQuery(cursor, limit)}`, { signal });

export const listAdminAudit = (cursor: string | null, limit: number, signal?: AbortSignal): Promise<IAuditPage> =>
  apiGet<IAuditPage>(`/admin/audit-events?${pageQuery(cursor, limit)}`, { signal });

// Пользователи
export const listUsers = (signal?: AbortSignal): Promise<IListResponse<IUser>> =>
  apiGet<IListResponse<IUser>>('/admin/users', { signal });

export const createUser = (input: IUserCreateInput, idempotencyKey: string): Promise<IUser> =>
  apiPost<IUser>('/admin/users', { body: input, idempotencyKey });

export const updateUser = (id: string, rowVersion: number, patch: IUserPatch): Promise<IUser> =>
  apiPatch<IUser>(`/admin/users/${enc(id)}`, { body: patch, ifMatch: etagOf(id, rowVersion) });

export const resetUserPassword = (id: string, rowVersion: number, password: string): Promise<IUser> =>
  apiPost<IUser>(`/admin/users/${enc(id)}/password`, { body: { password }, ifMatch: etagOf(id, rowVersion) });
