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

// Комплект экспорта: PDF и его metadata приходят одним набором с общим именем
// (`A.pdf`, `A_blocks.json`, `A_results.md`, `A_results.html` — discovery §7.1).
// Ключ группы — путь без роли: по нему metadata привязывается к своему PDF, а не выбирается
// независимо. Иначе в один архив можно положить PDF одного документа и распознавание другого,
// и SHA-256 такую подмену не поймает (R04-08).
const SUFFIXES: Record<Exclude<RdwebMemberRole, 'other'>, string[]> = {
  pdf: ['.pdf'],
  blocks_json: ['_blocks.json', '.json'],
  results_md: ['_results.md', '.md'],
  results_html: ['_results.html', '.html', '.htm'],
};

export const groupKeyOf = (memberPath: string, role: RdwebMemberRole): string | null => {
  if (role === 'other') return null;
  const lower = memberPath.replace(/\\/g, '/').toLowerCase();
  const slash = lower.lastIndexOf('/');
  const dir = slash >= 0 ? lower.slice(0, slash + 1) : '';
  const name = slash >= 0 ? lower.slice(slash + 1) : lower;
  for (const suffix of SUFFIXES[role]) {
    if (name.endsWith(suffix)) return dir + name.slice(0, name.length - suffix.length);
  }
  return dir + name;
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
