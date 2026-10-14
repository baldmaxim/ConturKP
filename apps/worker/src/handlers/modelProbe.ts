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
    // Сигнал задания — в пробу (R17-02): остановка worker и потеря аренды прерывают запрос к модели, а шлюз
    // (guardGateway) превращает прерванный вызов в остановку, а не в «модель недоступна».
    await runSearchMaintenance({ pool: ctx.pool, config: ctx.config, embeddings: ctx.embeddings, log: () => undefined, signal: ctx.signal }, { checkModel: true });
    await ctx.complete();
  },
};
