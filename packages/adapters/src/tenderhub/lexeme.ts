// Разбор JSON TenderHub без промежуточного float (ADR-005 §2). Способ — доступ к исходному тексту
// значения при разборе: reviver JSON.parse получает context.source (Node.js 21+, V8). Каждое число
// превращается в лексему источника; значение float, которое строит JSON.parse, дальше не используется.
import { isDecimalLexeme } from '@kontur/core';
import { thError } from './types.ts';

export class NumLex {
  readonly lexeme: string;
  constructor(lexeme: string) {
    this.lexeme = lexeme;
  }
}

export const parseJsonWithLexemes = (text: string): unknown => {
  let missingSource = false;
  let value: unknown;
  try {
    value = JSON.parse(text, (_key: string, v: unknown, ...rest: unknown[]) => {
      if (typeof v !== 'number') return v;
      const source = (rest[0] as { source?: unknown } | undefined)?.source;
      if (typeof source !== 'string') {
        missingSource = true;
        return v;
      }
      return new NumLex(source);
    });
  } catch {
    throw thError('CONTRACT_MISMATCH', 'non_json_response', 'ответ TenderHub — не JSON (ответил прокси или другой сервис)', false);
  }
  // Без исходного текста чисел разбор потерял бы точность: такой среды быть не должно.
  if (missingSource) throw new Error('JSON.parse не отдаёт исходный текст чисел: нужна среда Node.js 21+');
  return value;
};

// Число контракта: лексема JSON-числа или десятичная строка (часть полей Go может отдавать строкой).
export const lexemeOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof NumLex) return v.lexeme;
  if (typeof v === 'string' && isDecimalLexeme(v)) return v;
  return null;
};
