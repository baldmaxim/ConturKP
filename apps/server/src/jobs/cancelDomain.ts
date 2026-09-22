// Доменная отмена задания (ревью 04-1, R04-02). Отмена, меняющая только строку job, оставляет
// доменный объект активным навсегда: прогон распознавания висит в queued, блокирует заморозку
// состава как recognition_in_progress и держит пару «редакция + архив», из-за чего повторная
// загрузка того же архива вечно возвращает reused без активного задания.
//
// Поэтому отмена queued-задания через API терминализует доменный объект в той же транзакции,
// что и сам job. Отмену running-задания подтверждает worker под действующей арендой
// (apps/worker/src/runtime.ts, IJobHandlerSpec.onCancel) — здесь она не нужна и не делается.
import { cancelRun, failBatch, type IJobRow, type PoolClient } from '@kontur/db';

type DomainCancel = (client: PoolClient, job: IJobRow) => Promise<void>;

const CANCEL_BY_KIND: Record<string, DomainCancel> = {
  'recognition.import': async (client, job) => {
    await cancelRun(client, String(job.payload.runId));
  },
  // Партия импорта страдает тем же: без этого она осталась бы running без задания.
  'import.expand': async (client, job) => {
    await failBatch(client, String(job.payload.batchId), 'cancelled');
  },
};

export const cancelJobDomain = async (client: PoolClient, job: IJobRow): Promise<void> => {
  await CANCEL_BY_KIND[job.kind]?.(client, job);
};
