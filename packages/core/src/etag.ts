// Оптимистичная конкуренция: ETag = "<id>:<row_version>" (ADR-005 §9).

export const formatEtag = (id: string, rowVersion: number): string => `"${id}:${rowVersion}"`;

export type IfMatchResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; id: string; rowVersion: number };

export const parseIfMatch = (header: string | undefined): IfMatchResult => {
  if (header === undefined || header.trim() === '') return { kind: 'missing' };
  const m = /^(?:W\/)?"([0-9a-f-]{36}):(\d{1,15})"$/i.exec(header.trim());
  if (!m || !m[1] || !m[2]) return { kind: 'invalid' };
  return { kind: 'ok', id: m[1].toLowerCase(), rowVersion: Number(m[2]) };
};
