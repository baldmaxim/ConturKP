// Пилот (этап 18, проект docs/architecture/18-pilot-design.md §3–§6) — общие типы и константы: PilotError, пороги
// метрик, имена схем, перечни видов и вердиктов, результат ворот и метрик. Логика — pilot-schema.ts (эталон,
// сопоставление, SHA-256, дословность цитаты), pilot-activity.ts (журнал времени, интервалы), pilot-gates.ts (ворота
// и метрики), pilot-candidate.ts (кандидат), pilot-report.ts (отчёт). Запросы к БД — pilot-db.ts, разбор аргументов
// и вывод — pilot.ts. В отчёт попадают идентификаторы и счётчики: без названий, текстов источников, ФИО и почт.

export class PilotError extends Error {}

export type GateStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'MANUAL' | 'NOT_AVAILABLE' | 'INFO';

// Пороги метрик (D-043, В-18-1: приняты владельцем).
export const THRESHOLDS = { m1Min: 80, m2Max: 25, m3Min: 95, m4Min: 100, timelogDeviation: 0.3 } as const;
// Разрыв между действиями одного пользователя, после которого начинается новый интервал активности (проект §6, М5).
export const ACTIVITY_GAP_MINUTES = 15;

export const REFERENCE_SCHEMA = 'kontur.pilot-reference.v1';
export const MATCHING_SCHEMA = 'kontur.pilot-matching.v1';
export const REPORT_SCHEMA = 'kontur.pilot-report.v1';

export const REFERENCE_KINDS = ['conflict', 'change', 'price_reason', 'decision'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export const FINDING_VERDICTS = ['true', 'valid_extra', 'false', 'duplicate'] as const;
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];
export const CITATION_VERDICTS = ['supports', 'does_not_support'] as const;
export type CitationVerdict = (typeof CITATION_VERDICTS)[number];

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface IResult {
  id: string;
  title: string;
  status: GateStatus;
  // Процент для метрик; null — не считается.
  value: number | null;
  threshold: string | null;
  detail: string;
  data: Record<string, unknown>;
}
