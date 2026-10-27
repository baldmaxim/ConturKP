import { ROLE_TITLE, roleOfKind, type IOfficeView, type TOfficeRole } from './officeModel.js';

export interface IOfficeDiagnostics {
  at: string; build: string | null; total: number; hidden: number; limit: number; truncated: boolean;
  entries: Array<{ jobId: string; kind: string; tenderId: string | null; errorCode: string | null; failedAt: string; attempts: number; maxAttempts: number }>;
}
const token = (value: string | null, limit = 300): string => (value ?? '—').replace(/[^\p{L}\p{N}_.:+/@-]/gu, '_').slice(0, limit);

/** Готовый отчёт для обращения: без payload, документов и сообщений интеграций. */
export const formatOfficeDiagnostics = (view: IOfficeView, details: IOfficeDiagnostics | null, stale: boolean, role: TOfficeRole | null, problem?: string): string => {
  const items = view.items.filter((item) => role === null || roleOfKind(item.kind) === role);
  const count = (status: string): number => items.filter((item) => item.status === status).reduce((sum, item) => sum + item.count, 0);
  const lines = ['Контур КП — диагностика «Офиса»', `Время снимка очереди: ${token(view.at)}`, `Время диагностики: ${token(details?.at ?? null)}`, `Сборка: ${token(details?.build ?? null, 2048)}`, `Связь: ${stale ? 'данные устарели' : 'актуальные данные'}`, `Живых worker’ов: ${view.workersAlive}`, `Область: ${role === null ? 'весь офис' : ROLE_TITLE[role]}`, `В работе: ${count('running')}; в очереди: ${count('queued')}; нерешённых ошибок за 24 ч: ${count('failed')}`, '', 'Группы заданий:'];
  const groups = new Map<string, { count: number; code: string | null; at: string | null }>();
  for (const item of items) {
    const key = `${token(item.kind)} | ${item.status}`, group = groups.get(key) ?? { count: 0, code: null, at: null };
    group.count += item.count;
    if (item.lastFailedAt && (!group.at || item.lastFailedAt > group.at)) { group.at = item.lastFailedAt; group.code = item.lastErrorCode; }
    groups.set(key, group);
  }
  for (const [key, group] of groups) lines.push(`${key} | ${group.count}${group.at ? ` | ${token(group.code)} | ${token(group.at)}` : ''}`);
  if (!groups.size) lines.push('Нет заданий.');
  if (details) {
    lines.push('', `Последние отказы доступных заданий: ${details.entries.length} (лимит ${details.limit})`);
    for (const entry of details.entries) lines.push(`${token(entry.failedAt)} | ${token(entry.kind)} | job=${token(entry.jobId)} | ${token(entry.errorCode)} | попытки ${entry.attempts}/${entry.maxAttempts}${entry.tenderId ? ` | tender=${token(entry.tenderId)}` : ''}`);
    lines.push(`Заданий по закрытым тендерам: ${details.hidden} (без подробностей).`);
    if (details.truncated) lines.push(`Выборка ограничена: показано ${details.entries.length} из ${details.total - details.hidden} доступных отказов.`);
    if (details.total === 0) lines.push('Нерешённых отказов нет.');
  } else lines.push('', `Подробный журнал недоступен: ${token(problem ?? 'REQUEST_FAILED')}. Скопирована сводка последнего снимка.`);
  return lines.join('\n');
};
