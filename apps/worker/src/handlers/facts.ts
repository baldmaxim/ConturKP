// Извлечение фактов D-018 (D-028; docs/architecture/08a-fact-graph-design.md §6): по прогону распознавания документа
// тендера или договора — классификация, факты и основания, затем пересчёт графа владельца — одной транзакцией под
// арендой. Правило, не модель; повтор — тот же прогон извлечения. Класс `default`: GPU не нужен.
import { extractRunFacts, recomputeOwnerGraph } from '@kontur/db';
import type { IJobHandlerSpec } from '../runtime.ts';

export const factExtractHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    await ctx.complete(async (client) => {
      const out = await extractRunFacts(client, runId);
      if (out.created && out.owner) await recomputeOwnerGraph(client, out.owner);
    });
  },
};
