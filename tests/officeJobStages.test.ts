import { describe, expect, it } from 'vitest';
import { OFFICE_JOB_STATUS, officeJobSteps, officeJobTitle, type IOfficeJob } from '../apps/web/src/pages/admin/office/officeJobs.ts';
import { ROLE_KINDS } from '../apps/web/src/pages/admin/office/officeModel.ts';
const job: IOfficeJob = { id: '1', kind: 'history.verify', status: 'queued', tenderId: null, tenderTitle: null, createdAt: '2026-10-26T08:00:00Z', updatedAt: '2026-10-26T08:00:00Z', finishedAt: null, attempts: 0, maxAttempts: 3, errorCode: null, progress: null, nextCheckAt: null, cancelRequested: false };

describe('русские названия и реальные этапы задач', () => {
  it('все известные виды заданий имеют русское действие', () => {
    for (const kind of Object.values(ROLE_KINDS).flat()) expect(officeJobTitle(kind)).toMatch(/[а-яё]/i);
    expect(officeJobTitle('history.scan')).toBe('Ищет изменения в папке');
    expect(officeJobTitle('history.verify')).toBe('Проверяет содержимое файлов');
    expect(officeJobTitle('unknown.kind')).toBe('Фоновая задача');
    for (const label of Object.values(OFFICE_JOB_STATUS)) expect(label).toMatch(/[а-яё]/i);
  });
  it('ожидание не выглядит выполненной работой, текущий этап берётся из прогресса', () => {
    expect(officeJobSteps(job).map(step => step.state)).toEqual(['done', 'pending', 'pending']);
    const steps = officeJobSteps({ ...job, status: 'running', progress: { phase: 'saving', completed: 10, total: 10, unit: 'files' } });
    expect(steps[1]).toMatchObject({ title: 'Сохранение', state: 'current' });expect(steps[2]!.state).toBe('pending');
  });
  it('ошибка и отмена не становятся успешным результатом', () => {
    expect(officeJobSteps({ ...job, status: 'failed' }).map(step => step.state)).toEqual(['done', 'failed', 'failed']);
    expect(officeJobSteps({ ...job, status: 'cancelled' })[2]!.state).toBe('cancelled');
    expect(officeJobSteps({ ...job, status: 'succeeded' }).every(step => step.state === 'done')).toBe(true);
  });
});
