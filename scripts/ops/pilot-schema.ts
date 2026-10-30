// Пилот (этап 18, проект §4, §5.3) — схемы эталона `kontur.pilot-reference.v1` и сопоставления
// `kontur.pilot-matching.v1`, SHA-256 файла, дословность цитаты. Чистая логика без БД и сети.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CITATION_VERDICTS,
  FINDING_VERDICTS,
  MATCHING_SCHEMA,
  PilotError,
  REFERENCE_KINDS,
  REFERENCE_SCHEMA,
  type CitationVerdict,
  type FindingVerdict,
  type ReferenceKind,
  type Validation,
} from './pilot-lib.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const sha256OfFile = (path: string): string => sha256Hex(readFileSync(path));

// ---------------------------------------------------------------- Эталон (проект §4.1)

export interface IReferenceSource {
  document: string;
  locator: string;
  quote: string;
}
export interface IReferenceItem {
  id: string;
  kind: ReferenceKind;
  critical: boolean;
  summary: string;
  sources: IReferenceSource[];
  expected: string;
}
export interface IReference {
  schema: typeof REFERENCE_SCHEMA;
  tenderId: string;
  author: string;
  createdAt: string;
  items: IReferenceItem[];
}


export const validateReference = (raw: unknown): Validation<IReference> => {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['корень: ожидается объект'] };
  if (raw.schema !== REFERENCE_SCHEMA) errors.push(`schema: ожидается «${REFERENCE_SCHEMA}»`);
  if (!isUuid(raw.tenderId)) errors.push('tenderId: ожидается uuid тендера портала');
  if (!nonEmpty(raw.author)) errors.push('author: ожидается непустая роль составителя');
  if (typeof raw.createdAt !== 'string' || !ISO_RE.test(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) {
    errors.push('createdAt: ожидается дата-время ISO 8601 с часовым поясом');
  }
  const items: IReferenceItem[] = [];
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    errors.push('items: ожидается непустой массив');
  } else {
    const seen = new Set<string>();
    raw.items.forEach((it: unknown, i) => {
      const at = `items[${i}]`;
      if (!isRecord(it)) {
        errors.push(`${at}: ожидается объект`);
        return;
      }
      const label = typeof it.id === 'string' && it.id ? `${at} (${it.id})` : at;
      if (!nonEmpty(it.id)) errors.push(`${at}.id: ожидается непустая строка`);
      else if (seen.has(it.id)) errors.push(`${label}: повторяющийся id`);
      else seen.add(it.id);
      if (typeof it.kind !== 'string' || !(REFERENCE_KINDS as readonly string[]).includes(it.kind)) {
        errors.push(`${label}.kind: одно из ${REFERENCE_KINDS.join(' | ')}`);
      }
      if (typeof it.critical !== 'boolean') errors.push(`${label}.critical: ожидается true или false`);
      if (!nonEmpty(it.summary)) errors.push(`${label}.summary: ожидается непустая строка`);
      if (!nonEmpty(it.expected)) errors.push(`${label}.expected: ожидается непустая строка`);
      const sources: IReferenceSource[] = [];
      if (!Array.isArray(it.sources)) {
        errors.push(`${label}.sources: ожидается массив`);
      } else {
        it.sources.forEach((s: unknown, j) => {
          if (!isRecord(s) || !nonEmpty(s.document) || typeof s.locator !== 'string' || typeof s.quote !== 'string') {
            errors.push(`${label}.sources[${j}]: ожидаются строки document (непустая), locator, quote`);
            return;
          }
          sources.push({ document: s.document, locator: s.locator, quote: s.quote });
        });
        if (it.critical === true && !sources.some((s) => s.quote.trim().length > 0)) {
          errors.push(`${label}: у критического пункта нужен хотя бы один источник с непустой цитатой`);
        }
      }
      if (nonEmpty(it.id) && typeof it.kind === 'string' && typeof it.critical === 'boolean' && nonEmpty(it.summary) && nonEmpty(it.expected)) {
        items.push({ id: it.id, kind: it.kind as ReferenceKind, critical: it.critical, summary: it.summary, sources, expected: it.expected });
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { schema: REFERENCE_SCHEMA, tenderId: raw.tenderId as string, author: raw.author as string, createdAt: raw.createdAt as string, items },
  };
};

export const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text.replace(/^﻿/u, '')) as unknown;
  } catch {
    throw new PilotError(`${what}: файл не является JSON`);
  }
};

// ---------------------------------------------------------------- Сопоставление (проект §4.2)

// Для пунктов price_reason found — идентификаторы версий причины портала (change_explanation.id); для остальных —
// идентификаторы замечаний, разногласий или ответов портала.
export interface IMatchingItem {
  id: string;
  result: 'found' | 'missed';
  found: string[];
}
export interface IMatchingFinding {
  id: string;
  verdict: FindingVerdict;
}
// ref — идентификатор замечания или прогона ответа портала, чья цитата проверена человеком.
export interface IMatchingCitation {
  ref: string;
  verdict: CitationVerdict;
}
export interface IMatching {
  schema: typeof MATCHING_SCHEMA;
  tenderId: string;
  items: IMatchingItem[];
  findings: IMatchingFinding[];
  citations: IMatchingCitation[];
}

export const validateMatching = (raw: unknown): Validation<IMatching> => {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['корень: ожидается объект'] };
  if (raw.schema !== MATCHING_SCHEMA) errors.push(`schema: ожидается «${MATCHING_SCHEMA}»`);
  if (!isUuid(raw.tenderId)) errors.push('tenderId: ожидается uuid тендера портала');
  const items: IMatchingItem[] = [];
  const findings: IMatchingFinding[] = [];
  const citations: IMatchingCitation[] = [];
  if (!Array.isArray(raw.items)) {
    errors.push('items: ожидается массив');
  } else {
    const seen = new Set<string>();
    raw.items.forEach((it: unknown, i) => {
      const at = `items[${i}]`;
      if (!isRecord(it) || !nonEmpty(it.id)) {
        errors.push(`${at}: ожидается объект с непустым id`);
        return;
      }
      if (seen.has(it.id)) errors.push(`${at} (${it.id}): повторяющийся id`);
      seen.add(it.id);
      if (it.result !== 'found' && it.result !== 'missed') {
        errors.push(`${at} (${it.id}).result: found | missed`);
        return;
      }
      const found = it.found === undefined ? [] : it.found;
      if (!Array.isArray(found) || !found.every(isUuid)) {
        errors.push(`${at} (${it.id}).found: ожидается массив uuid`);
        return;
      }
      if (it.result === 'found' && found.length === 0) errors.push(`${at} (${it.id}): found без идентификаторов портала`);
      if (it.result === 'missed' && found.length > 0) errors.push(`${at} (${it.id}): missed с идентификаторами портала`);
      items.push({ id: it.id, result: it.result, found: found as string[] });
    });
  }
  const list = (key: 'findings' | 'citations', idKey: 'id' | 'ref', verdicts: readonly string[], sink: (id: string, verdict: string) => void): void => {
    const value = raw[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`${key}: ожидается массив`);
      return;
    }
    const seen = new Set<string>();
    value.forEach((it: unknown, i) => {
      const at = `${key}[${i}]`;
      if (!isRecord(it) || !isUuid(it[idKey])) {
        errors.push(`${at}.${idKey}: ожидается uuid`);
        return;
      }
      if (typeof it.verdict !== 'string' || !verdicts.includes(it.verdict)) {
        errors.push(`${at}.verdict: одно из ${verdicts.join(' | ')}`);
        return;
      }
      const id = it[idKey] as string;
      if (seen.has(id)) errors.push(`${at}: повторяющийся ${idKey}`);
      seen.add(id);
      sink(id, it.verdict);
    });
  };
  list('findings', 'id', FINDING_VERDICTS, (id, verdict) => findings.push({ id, verdict: verdict as FindingVerdict }));
  list('citations', 'ref', CITATION_VERDICTS, (ref, verdict) => citations.push({ ref, verdict: verdict as CitationVerdict }));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { schema: MATCHING_SCHEMA, tenderId: raw.tenderId as string, items, findings, citations } };
};

// Согласованность эталона и сопоставления: тот же тендер, каждый пункт эталона размечен, лишних пунктов нет.
export const crossCheck = (reference: IReference, matching: IMatching): string[] => {
  const problems: string[] = [];
  if (reference.tenderId.toLowerCase() !== matching.tenderId.toLowerCase()) problems.push('tenderId эталона и сопоставления различаются');
  const refIds = new Set(reference.items.map((i) => i.id));
  const matchIds = new Set(matching.items.map((i) => i.id));
  for (const id of refIds) if (!matchIds.has(id)) problems.push(`пункт эталона ${id} не размечен в сопоставлении`);
  for (const id of matchIds) if (!refIds.has(id)) problems.push(`в сопоставлении пункт ${id}, которого нет в эталоне`);
  return problems;
};

// Печать эталона: отказ, если SHA-256 файла не равен напечатанному `reference-seal`.
export const assertSealed = (actualSha256: string, sealedSha256: string): void => {
  if (!/^[0-9a-f]{64}$/iu.test(sealedSha256)) throw new PilotError('--sealed: ожидается SHA-256 (64 шестнадцатеричных символа)');
  if (actualSha256.toLowerCase() !== sealedSha256.toLowerCase()) {
    throw new PilotError('SHA-256 эталона не равен печати --sealed: эталон изменён после печати, отчёт не строится');
  }
};

export const referenceStats = (reference: IReference): { items: number; critical: number } => ({
  items: reference.items.length,
  critical: reference.items.filter((i) => i.critical).length,
});

// ---------------------------------------------------------------- Дословность цитаты (проект §5.3)

// Нормализация: мягкий перенос U+00AD удаляется; все пробельные символы (в том числе неразрывный пробел и переводы
// строки) — один пробел; края обрезаются. Регистр не меняется.
export const normalizeQuoteText = (s: string): string => s.replace(/­/gu, '').replace(/\s+/gu, ' ').trim();

export const isVerbatim = (fragmentText: string, quote: string): boolean => {
  const q = normalizeQuoteText(quote);
  return q.length > 0 && normalizeQuoteText(fragmentText).includes(q);
};
