// Вызовы графа фактов D-018 (этап 08a; portal-api §2.12).
import { apiGet, apiPost } from './client';
import type { IFactGraphView, TFactDecisionKind } from './factTypes';

const enc = encodeURIComponent;

export const getContractFactGraph = (contractId: string, signal?: AbortSignal): Promise<IFactGraphView> => apiGet(`/contracts/${enc(contractId)}/fact-graph`, { signal });

export const getTenderFactGraph = (tenderId: string, signal?: AbortSignal): Promise<IFactGraphView> => apiGet(`/tenders/${enc(tenderId)}/fact-graph`, { signal });

export const getFactGraph = (owner: { kind: 'tender' | 'contract'; id: string }, signal?: AbortSignal): Promise<IFactGraphView> =>
  owner.kind === 'contract' ? getContractFactGraph(owner.id, signal) : getTenderFactGraph(owner.id, signal);

/** Решение человека по паре фактов: ребро графа; ответ — пересчитанный граф владельца. */
export const decideFacts = (
  factId: string,
  input: { otherFactId: string; kind: TFactDecisionKind; reason: string },
  idempotencyKey: string,
): Promise<{ decisionId: string; graph: IFactGraphView }> => apiPost(`/evidence-facts/${enc(factId)}/decisions`, { body: input, idempotencyKey });
