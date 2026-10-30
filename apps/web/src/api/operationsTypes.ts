// Состояние установки и статусы интеграций (этап 17, portal-api §2): без адресов, ключей и путей.

export type TIntegrationStatus = 'NOT_IMPLEMENTED' | 'VERIFIED_FIXTURE' | 'VERIFIED_LIVE' | 'BLOCKED_EXTERNAL';
export type TSpaceLevel = 'ok' | 'warn' | 'stop' | 'unknown';

export interface IIntegrationView {
  system: string;
  component: string;
  status: TIntegrationStatus;
  evidenceRef: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

export interface IOperationsView {
  build: string | null;
  env: string;
  workerMode: 'normal' | 'restore_check';
  schema: { version: number; migrations: number; ok: boolean; problem: string | null };
  processes: Array<{ kind: string; pid: number; startedAt: string; lastSeenAt: string }>;
  queue: {
    byKind: Array<{ kind: string; status: string; count: number }>;
    oldestQueuedSeconds: number | null;
    overdueRunning: number;
    failed24h: number;
    gpu: { holderKind: string | null; lockedUntil: string | null };
  };
  storage: { level: TSpaceLevel; freeBytes: number | null; warnFreeBytes: number; stopFreeBytes: number; blobs: { count: number; bytes: number } };
  backup: {
    configured: boolean;
    last: { name: string; finishedAt: string; schemaVersion: number; files: number; filesBytes: number; dumpBytes: number; role: string } | null;
    problem?: string;
  };
  integrations: IIntegrationView[];
}

// «Офис» (вкладка администрирования): типы ответа объявлены рядом с моделью офиса, которая не имеет импортов
// (её читают и тесты под корневым tsconfig).
export type { IOfficeItemView, IOfficeView, TOfficeJobStatus } from '../pages/admin/office/officeModel';
