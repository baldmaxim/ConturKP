// Вызовы этапа 17: состояние установки (администратор) и статусы интеграций (любой вошедший пользователь).
import { apiGet } from './client';
import type { IIntegrationView, IOperationsView } from './operationsTypes';

export const getOperations = (signal?: AbortSignal) => apiGet<IOperationsView>('/admin/operations', { signal });

export const listIntegrationStatuses = (signal?: AbortSignal) => apiGet<{ items: IIntegrationView[] }>('/integrations/status', { signal });
