// Сводка прогона для человека (I07, I18): «Проверка завершена: замечаний нет» — только при завершённом прогоне без
// пробелов, без нерешённых замечаний и гипотез и при актуальных входах. Пустой результат, незавершённое задание,
// неполная проверка или принятый риск такой сводки не дают.
import type { CheckOutcome, ReviewRunStatus } from './types.ts';

export type ReviewSummaryKind = 'running' | 'failed' | 'outdated' | 'incomplete' | 'findings' | 'risk_accepted' | 'clean';

export interface IReviewSummaryInput {
  status: ReviewRunStatus;
  outcomes: readonly CheckOutcome[];
  unsettledFindings: number;
  acceptedRisks: number;
  openSuggestions: number;
  outdated: boolean;
}

export const reviewSummary = (s: IReviewSummaryInput): { kind: ReviewSummaryKind; text: string } => {
  if (s.status === 'queued' || s.status === 'running') return { kind: 'running', text: 'Проверка выполняется: итога ещё нет' };
  if (s.status === 'failed') return { kind: 'failed', text: 'Проверка не выполнена: итога нет' };
  if (s.outdated) return { kind: 'outdated', text: 'Проверка устарела: после неё изменились входы этапа — нужна повторная проверка' };
  const gaps = s.outcomes.filter((o) => o === 'incomplete' || o === 'error').length;
  if (s.status === 'completed_with_gaps' || gaps > 0) return { kind: 'incomplete', text: `Проверка неполная: пробелов — ${gaps}` };
  if (s.unsettledFindings > 0 || s.openSuggestions > 0) {
    return { kind: 'findings', text: `Есть замечания: нерешённых — ${s.unsettledFindings}, гипотез модели к разбору — ${s.openSuggestions}` };
  }
  if (s.acceptedRisks > 0) return { kind: 'risk_accepted', text: `Замечаний к устранению нет; принят риск — ${s.acceptedRisks}` };
  return { kind: 'clean', text: 'Проверка завершена: замечаний нет' };
};
