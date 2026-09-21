// Классификация членов экспортного архива. Имена в образце — `<документ>.pdf`,
// `<документ>_results.md`, `<документ>_results.html`, `<документ>_blocks.json`, но опираться
// только на точные имена нельзя: экспорт мог назвать файлы иначе. Поэтому роль выбирается
// по расширению, а точное имя даёт приоритет.

export type RdwebMemberRole = 'pdf' | 'blocks_json' | 'results_md' | 'results_html' | 'other';

export interface IMemberChoice {
  role: RdwebMemberRole;
  // Чем выше, тем увереннее совпадение: 2 — имя образца, 1 — подходящее расширение.
  score: number;
}

const baseName = (memberPath: string): string => (memberPath.split('/').pop() ?? memberPath).toLowerCase();

export const classifyMember = (memberPath: string): IMemberChoice => {
  const name = baseName(memberPath);
  if (name.endsWith('_blocks.json')) return { role: 'blocks_json', score: 2 };
  if (name.endsWith('.json')) return { role: 'blocks_json', score: 1 };
  if (name.endsWith('_results.md')) return { role: 'results_md', score: 2 };
  if (name.endsWith('.md')) return { role: 'results_md', score: 1 };
  if (name.endsWith('_results.html')) return { role: 'results_html', score: 2 };
  if (name.endsWith('.html') || name.endsWith('.htm')) return { role: 'results_html', score: 1 };
  if (name.endsWith('.pdf')) return { role: 'pdf', score: 2 };
  return { role: 'other', score: 0 };
};

export interface IPickedMember {
  memberPath: string;
  score: number;
}

// Выбор одного члена на роль: выигрывает больший приоритет, при равенстве — первый по порядку.
// Остальные кандидаты возвращаются как лишние, чтобы прогон честно сообщил о неоднозначности.
export const pickMember = (candidates: IPickedMember[]): { chosen: IPickedMember | null; ignored: string[] } => {
  if (candidates.length === 0) return { chosen: null, ignored: [] };
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const chosen = sorted[0]!;
  return { chosen, ignored: sorted.slice(1).map((c) => c.memberPath) };
};
