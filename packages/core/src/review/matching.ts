// Сопоставление текста, единиц и количеств для проверок этапа 09 (C04, C06; D-029 В-09-6) и ключ замечания.
import type { IRequirementParameter } from '../requirements.ts';
import { sha256Hex } from '../search.ts';
import { PD_UNCERTAINTY_PATTERNS, type FindingKind } from './types.ts';

export const findingKey = (kind: FindingKind, ...parts: readonly string[]): string => sha256Hex(`kontur.finding.v1\n${kind}\n${parts.join('\n')}`);

export const calcObjectKey = (revisionId: string, positionId: string, itemId: string | null): string => `${revisionId}|${positionId}|${itemId ?? ''}`;

// Нормализация для сравнения текста: регистр, «ё», «№ 1» = «№1», разделители.
export const normalizeMatchText = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/№\s+/gu, '№')
    .replace(/[«»"'()[\],;:]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const tokensOf = (s: string): string[] => normalizeMatchText(s).match(/[\p{L}\d№.\-/]+/gu) ?? [];
const hasDigit = (t: string): boolean => /\d/u.test(t);
// Основа слова — первые 5 букв (склонение: «клинкерный» ~ «клинкерным»); токены с цифрами и «№» — точно.
const stemOf = (t: string): string => (hasDigit(t) || t.includes('№') ? t : t.slice(0, 5));

// Значение параметра найдено в текстах: каждое значимое слово значения есть среди слов текста (основа или точно).
export const valueFoundIn = (value: string, texts: readonly string[]): boolean => {
  const wanted = tokensOf(value).filter((t) => hasDigit(t) || t.length >= 3);
  if (wanted.length === 0) return true;
  const have = new Set(texts.flatMap((t) => tokensOf(t)).map(stemOf));
  return wanted.every((t) => have.has(stemOf(t)));
};

// Единица измерения для сравнения (повторяет unit_normalize из 0020).
export const normalizeUnit = (u: string | null): string | null => {
  if (!u || u.trim() === '') return null;
  const v = u.trim().toLowerCase().replace(/[³]/gu, '3').replace(/[²]/gu, '2').replace(/[\^.]/gu, '').replace(/\s+/gu, '');
  const map: Record<string, string> = { кубм: 'м3', мкуб: 'м3', квм: 'м2', мкв: 'м2', пм: 'м', погм: 'м', мп: 'м', тн: 'т', тонна: 'т', штук: 'шт', комплект: 'компл' };
  return map[v] ?? v;
};

const MEASURE_UNITS = new Set(['м', 'м2', 'м3', 'шт', 'т', 'кг', 'компл', 'км', 'л', 'п', 'пог']);

// Количественный параметр: число и единица измерения (сравнивается с объёмом, а не ищется в тексте).
export const quantityOf = (p: IRequirementParameter): { value: number; unit: string } | null => {
  const unit = normalizeUnit(p.unit);
  if (!unit || !MEASURE_UNITS.has(unit)) return null;
  const m = /^\s*(-?\d[\d\s]*(?:[.,]\d+)?)\s*$/u.exec(p.value);
  if (!m) return null;
  const value = Number(m[1]!.replace(/\s+/gu, '').replace(',', '.'));
  return Number.isFinite(value) ? { value, unit } : null;
};

export const hasPdUncertainty = (text: string): boolean => PD_UNCERTAINTY_PATTERNS.some((p) => p.test(text));
