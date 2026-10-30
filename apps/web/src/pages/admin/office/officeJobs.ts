import { TASK_ACTION, type IOfficeTask, type TOfficeRole } from './officeModel.js';

export type TOfficeJobStatus = 'queued' | 'running' | 'failed' | 'succeeded' | 'cancelled';
export type TOfficeJobFilter = 'active' | TOfficeJobStatus;
export interface IOfficeJob {
  id: string; kind: string; status: TOfficeJobStatus;
  tenderId: string | null; tenderTitle: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
  attempts: number; maxAttempts: number; errorCode: string | null;
  progress: IOfficeTask['progress']; nextCheckAt: string | null; cancelRequested: boolean;
}
export interface IOfficeJobPage {
  at: string; total: number; hidden: number; limit: number; offset: number; hasMore: boolean;
  counts: Record<TOfficeJobStatus, number>; items: IOfficeJob[];
}
export interface IOfficeJobScope { role: TOfficeRole; title: string; kinds: string[]; tender?: string; status?: TOfficeJobFilter; jobId?: string }
export const OFFICE_JOB_STATUS: Record<TOfficeJobStatus, string> = {
  queued: 'В очереди', running: 'Выполняется', failed: 'Ошибка', succeeded: 'Завершено', cancelled: 'Отменено',
};
export const officeJobTitle = (kind: string): string => TASK_ACTION[kind] ?? 'Фоновая задача';
export const officeJobProgressTask = (job: IOfficeJob): IOfficeTask => ({
  id: job.id, kind: job.kind, tenderId: job.tenderId, hidden: false, count: 1,
  title: officeJobTitle(job.kind), progress: job.progress,
});

/** Временная шкала отражает записи очереди, а не придуманную историю внутренних шагов. */
export const officeJobSteps = (job: IOfficeJob) => {
  const phase = job.progress?.phase;
  const execution = job.status === 'queued' ? 'pending' : job.status === 'running' ? 'current' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : 'done';
  return [
    { title: 'Постановка в очередь', state: 'done', detail: job.createdAt },
    { title: phase === 'preparing' ? 'Подготовка' : phase === 'processing' ? 'Обработка' : phase === 'saving' ? 'Сохранение' : 'Выполнение', state: execution, detail: null },
    { title: job.status === 'failed' ? 'Завершилось ошибкой' : job.status === 'cancelled' ? 'Задание отменено' : 'Результат',
      state: job.status === 'succeeded' ? 'done' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : 'pending', detail: job.finishedAt },
  ];
};

export const officeJobError = (code: string | null): string => code === 'ORIGINAL_NOT_AVAILABLE'
  ? 'Источник не отдаёт оригинал письма. Остальные задания продолжают обрабатываться.'
  : code === 'TIMEOUT' ? 'Источник не ответил за отведённое время.'
    : code ? 'Задание завершилось с ошибкой. Технический код указан ниже.' : 'Подробности ошибки не переданы.';
