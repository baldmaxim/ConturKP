// Задание analysis.rules (D-018, D-028: судьба `requirement_candidate`): кандидаты требований из фактов графа девяти
// типов, основания которых — во входе прогона (фрагменты снимка, которые запустивший читает). Граф — по снимку реестра;
// перекрытые факты кандидатами не становятся, факт в конфликте — кандидат с пометкой. Правило, не модель; решение
// «этот пункт — требование этапа» остаётся человеку (подтверждение кандидата).
import { factDisplay, factParameter, FACT_RULES_VERSION, FACT_TYPE_META, type IModelRequirementCandidate } from '@kontur/core';
import {
  analysisRunInputIds,
  finishAnalysisRun,
  getAnalysisRun,
  insertModelRequirementCandidates,
  scopeFactGraph,
  scopeRecognitionUnits,
  startAnalysisRun,
} from '@kontur/db';
import type { IJobHandlerSpec } from '../runtime.ts';

export const analysisRulesHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const initial = await getAnalysisRun(ctx.pool, runId);
    if (!initial || !['queued', 'running'].includes(initial.status)) {
      await ctx.complete();
      return;
    }
    await ctx.complete(async (client) => {
      await startAnalysisRun(client, runId);
      const run = (await getAnalysisRun(client, runId))!;
      const inputs = new Set(await analysisRunInputIds(client, runId));
      const facts = await scopeFactGraph(client, await scopeRecognitionUnits(client, run.evidence_scope_id));
      const eligible = facts.filter((f) => FACT_TYPE_META[f.factType]?.fate === 'requirement_candidate');
      const usable = eligible.filter((f) => f.status !== 'superseded' && f.fragmentIds.every((id) => inputs.has(id)));
      const items: IModelRequirementCandidate[] = usable.map((f) => {
        const meta = FACT_TYPE_META[f.factType];
        const p = factParameter(f.normalized);
        return {
          statement: `${meta.title}: ${factDisplay(f.normalized)}${f.clauseRef ? ` (п. ${f.clauseRef})` : ''}`,
          parameters: [{ name: meta.title, value: p.value, unit: p.unit }],
          objectScope: {},
          rationale: `Правило ${FACT_RULES_VERSION}: «${f.rawValue.slice(0, 300)}»${f.status === 'conflict' ? '. Значение в конфликте с другим документом — какое действует, решает человек.' : ''}`,
          confidence: null,
          evidence: f.fragmentIds.map((fragmentId) => ({ fragmentId, role: 'supports' as const })),
        };
      });
      const saved = await insertModelRequirementCandidates(client, run, items);
      await finishAnalysisRun(client, runId, {
        status: 'completed',
        failureCode: null,
        coverage: {
          rulesVersion: FACT_RULES_VERSION,
          facts: facts.length,
          eligible: eligible.length,
          skippedSuperseded: eligible.filter((f) => f.status === 'superseded').length,
          skippedNotInInput: eligible.filter((f) => f.status !== 'superseded' && !f.fragmentIds.every((id) => inputs.has(id))).length,
          conflicts: usable.filter((f) => f.status === 'conflict').length,
          candidatesSaved: saved,
        },
        result: { candidatesSaved: saved },
      });
    });
  },
  onTerminalFailure: async (client, ctx, failure) => {
    const run = await getAnalysisRun(client, String(ctx.job.payload.runId));
    if (run) await finishAnalysisRun(client, run.id, { status: 'failed', failureCode: failure.code.slice(0, 60), coverage: run.coverage, result: run.result ?? null });
  },
};
