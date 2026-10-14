// Проба модели эмбеддингов (этап 17, S17-07, проект §7.5): задание класса gpu, а не вызов из прохода обслуживания.
// Так проба занимает слот GPU, как любое GPU-задание портала, и одновременно с ним к модели не обращается: портал
// держит у модели не больше одного своего запроса. Проба — настоящий запрос (у LM Studio он загружает модель),
// поэтому ставится редко (EMBEDDING_PROBE_INTERVAL_SECONDS). Результат — тот же проход обслуживания поиска с проверкой
// модели: статус, отпечаток, версия индекса с моделью.
import { runSearchMaintenance } from '../maintenance.ts';
import type { IJobContext, IJobHandlerSpec } from '../runtime.ts';

export const MODEL_PROBE_KIND = 'model.probe';
export const MODEL_PROBE_PRIORITY = 95;

export const modelProbeHandler: IJobHandlerSpec = {
  run: async (ctx: IJobContext) => {
    await runSearchMaintenance({ pool: ctx.pool, config: ctx.config, embeddings: ctx.embeddings, log: () => undefined }, { checkModel: true });
    await ctx.complete();
  },
};
