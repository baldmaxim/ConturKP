// Область вызова инструмента (проект §4): тендер и этап либо выпуск. Портал не выбирает тендер по тексту вопроса
// (D-019): без области инструмент отвечает `needs_selection` со списком доступных дел — без данных тендеров.
import { contentTenderIds, getCandidate, getRelease, getStage, listStages, listTenders, type Queryable } from '@kontur/db';
import { HttpError } from '../http/errors.ts';
import { loadVisibleRelease } from '../releaseViews.ts';
import { McpToolError, outOfScope, type IMcpSession } from './session.ts';

export interface ICaseScope {
  tenderId: string;
  stageId: string;
  releaseId: string | null;
  // Снимок источников комплекта выпуска: область исторического вопроса (A11).
  evidenceScopeId: string | null;
}

export interface ICaseChoice {
  tenderId: string;
  code: string;
  title: string;
  customer: string | null;
  stages: { stageId: string; seq: number; title: string; status: string; submissionDeadline: string | null }[];
}

// Дела, содержимое которых доступно пользователю: код, название, заказчик и этапы. Ничего из содержимого.
export const listCases = async (db: Queryable, s: IMcpSession, search?: string): Promise<ICaseChoice[]> => {
  const content = new Set(contentTenderIds(s.ctx));
  const needle = search?.trim().toLowerCase() ?? '';
  const tenders = (await listTenders(db, s.ctx)).filter((t) => content.has(t.id)).filter((t) => !needle || `${t.code} ${t.title} ${t.customer_name ?? ''}`.toLowerCase().includes(needle));
  const out: ICaseChoice[] = [];
  for (const t of tenders) {
    const stages = await listStages(db, s.ctx, t.id);
    out.push({
      tenderId: t.id,
      code: t.code,
      title: t.title,
      customer: t.customer_name ?? null,
      stages: stages.map((x) => ({ stageId: x.id, seq: x.seq, title: x.title, status: x.status, submissionDeadline: x.submission_deadline ? x.submission_deadline.toISOString() : null })),
    });
  }
  return out;
};

export const needsSelection = async (db: Queryable, s: IMcpSession, message: string): Promise<McpToolError> =>
  new McpToolError('needs_selection', message, { cases: await listCases(db, s) });

export const resolveCase = async (db: Queryable, s: IMcpSession, a: { tenderId?: string | undefined; stageId?: string | undefined; releaseId?: string | undefined }): Promise<ICaseScope> => {
  if (!a.tenderId || (!a.stageId && !a.releaseId)) throw await needsSelection(db, s, 'укажите тендер и его этап или выпуск: область по тексту вопроса не выбирается');
  if (a.stageId && a.releaseId) throw new McpToolError('invalid_request', 'укажите этап или выпуск, но не оба');
  const tenderId = a.tenderId.toLowerCase();
  if (!contentTenderIds(s.ctx).includes(tenderId)) throw outOfScope();
  if (a.stageId) {
    const stage = await getStage(db, s.ctx, a.stageId.toLowerCase());
    if (!stage || stage.tender_id !== tenderId) throw outOfScope();
    return { tenderId, stageId: stage.id, releaseId: null, evidenceScopeId: null };
  }
  const releaseId = a.releaseId!.toLowerCase();
  try {
    const { release } = await loadVisibleRelease(db, s.ctx, await getRelease(db, releaseId), releaseId);
    if (release.tender_id !== tenderId) throw outOfScope();
    const candidate = (await getCandidate(db, release.candidate_id))!;
    return { tenderId, stageId: release.stage_id, releaseId: release.id, evidenceScopeId: candidate.evidence_scope_id };
  } catch (err) {
    // Чужой, несуществующий и закрытый для пользователя выпуск неразличимы.
    if (err instanceof HttpError) throw outOfScope();
    throw err;
  }
};
