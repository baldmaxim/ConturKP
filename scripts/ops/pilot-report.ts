// Пилот (этап 18, проект §5.3, §6) — сборка отчёта JSON и Markdown. Чистая логика без БД и сети.
import type { IActivityRow } from './pilot-activity.ts';
import { REPORT_SCHEMA, type GateStatus, type IResult } from './pilot-lib.ts';

export interface IReportInput {
  generatedAt: string;
  tenderId: string;
  referenceSha256: string;
  matchingSha256: string;
  referenceStats: { items: number; critical: number };
  gates: IResult[];
  metrics: IResult[];
  notAvailable: string[];
  limitations: string[];
}
export interface IPilotReport extends IReportInput {
  schema: typeof REPORT_SCHEMA;
  summary: { failed: string[]; notRun: string[]; manual: string[]; notAvailable: string[]; automaticPass: boolean };
}

export const buildReport = (input: IReportInput): IPilotReport => {
  const all = [...input.gates, ...input.metrics];
  const ids = (status: GateStatus): string[] => all.filter((r) => r.status === status).map((r) => r.id);
  return {
    schema: REPORT_SCHEMA,
    ...input,
    summary: {
      failed: ids('FAIL'),
      notRun: ids('NOT_RUN'),
      manual: ids('MANUAL'),
      notAvailable: ids('NOT_AVAILABLE'),
      automaticPass: all.every((r) => r.status === 'PASS' || r.status === 'MANUAL' || r.status === 'INFO'),
    },
  };
};

const cell = (s: string): string => s.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

export const renderReportMarkdown = (r: IPilotReport): string => {
  const row = (x: IResult): string =>
    `| ${x.id} | ${cell(x.title)} | ${x.status} | ${x.value === null ? '—' : `${x.value} %`} | ${x.threshold ?? '—'} | ${cell(x.detail)} |`;
  const head = ['| ID | Показатель | Статус | Значение | Порог | Подробности |', '|---|---|---|---|---|---|'];
  const m5 = r.metrics.find((m) => m.id === 'M5');
  const users = (m5?.data.users ?? []) as IActivityRow[];
  const g6 = r.gates.find((g) => g.id === 'G6');
  return [
    '# Отчёт пилота Контур КП',
    '',
    `Сформирован: ${r.generatedAt}`,
    `Тендер портала: ${r.tenderId}`,
    `Эталон: SHA-256 ${r.referenceSha256}; пунктов ${r.referenceStats.items}, критических ${r.referenceStats.critical}`,
    `Сопоставление: SHA-256 ${r.matchingSha256}`,
    '',
    `Итог автоматических проверок: ${r.summary.automaticPass ? 'без FAIL' : `FAIL — ${r.summary.failed.join(', ')}`}`,
    r.summary.notRun.length > 0 ? `Не выполнялись (NOT_RUN): ${r.summary.notRun.join(', ')}` : '',
    r.summary.notAvailable.length > 0 ? `Недоступно (NOT_AVAILABLE): ${r.summary.notAvailable.join(', ')}` : '',
    '',
    '## Ворота',
    '',
    ...head,
    ...r.gates.map(row),
    '',
    `G6 — ссылка на журнал ops:restore-check (заполнить вручную): ${typeof g6?.data.evidenceRef === 'string' ? g6.data.evidenceRef : '________'}`,
    '',
    '## Метрики',
    '',
    ...head,
    ...r.metrics.map(row),
    '',
    '## М5. Время по пользователям',
    '',
    '| Пользователь (id) | Роли | Действий | Интервалов | По аудиту, мин | По журналу, мин | Расхождение | Отмечено |',
    '|---|---|---|---|---|---|---|---|',
    ...users.map(
      (u) =>
        `| ${u.userId} | ${u.roles.join(', ') || '—'} | ${u.events} | ${u.intervals} | ${Math.round(u.auditMinutes * 10) / 10} | ${u.loggedMinutes === null ? '—' : u.loggedMinutes} | ${u.deviation === null ? '—' : `${Math.round(u.deviation * 1000) / 10} %`} | ${u.flagged ? 'да' : 'нет'} |`,
    ),
    '',
    '## Ограничения и отметки NOT_AVAILABLE',
    '',
    ...(r.notAvailable.length + r.limitations.length > 0 ? [...r.notAvailable, ...r.limitations].map((x) => `- ${x}`) : ['- нет']),
    '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
};
