// Нормализация текста и метрики качества единицы. Перенос донора Locus (D-013, OD-7):
// apps/rag-api/src/text.js (normalizeText, здесь normalizeLocalText) и apps/rag-api/src/converters.js (textQualityReport,
// recognitionNoiseReport, ocrPageReport, usablePdfTextLayer, usableOcrPage), коммит 33c6bcf.
// Метрики перенесены без изменения смысла; числа шлюза — свои, по замеру корпуса фикстур (OD-6):
// распределение и выбор — в docs/stages/05a-report.md. Уверенность OCR — один из критериев, не единственный.
import type { ITextMetrics, LocalUnitStatus } from './types.ts';

export const normalizeLocalText = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

const WORD_TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;
const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const DIGIT_RE = /\p{N}/u;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

// «Шумные» токены распознавания: смесь латиницы и кириллицы в одном слове или буквы с цифрами
// в слове от 4 символов — типичный след неудачного OCR или сломанной кодировки шрифта PDF.
export const textMetrics = (raw: string): ITextMetrics => {
  const text = normalizeLocalText(raw);
  const chars = text.length;
  const tokens = Array.from(text.matchAll(WORD_TOKEN_RE), (m) => m[0]);
  let letterTokens = 0;
  let noisy = 0;
  for (const token of tokens) {
    if (!LETTER_RE.test(token)) continue;
    letterTokens += 1;
    const latin = LATIN_RE.test(token);
    const cyrillic = CYRILLIC_RE.test(token);
    if (latin && cyrillic) noisy += 1;
    else if (token.length >= 4 && DIGIT_RE.test(token)) noisy += 1;
  }
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    chars,
    words: tokens.length,
    letterRatio: chars ? round(count(text, /\p{L}/gu) / chars) : 0,
    replacementRatio: chars ? round(count(text, /\uFFFD/gu) / chars) : 0,
    noiseRatio: letterTokens ? round(noisy / letterTokens) : 0,
    noisyTokens: noisy,
  };
};

// Шлюз качества (OD-6). Числа выбраны по замеру корпуса фикстур 05a и Locus (artifacts/stage-05a/
// quality-metrics.log, отчёт этапа §«Порог качества»): уверенность OCR чистого скана — 94, смягчённого —
// 58 (текст с ошибками), испорченного — 32, изображения-шума — 25 (мусор). Порог донора «≥ 25» пропускал
// шум, поэтому он не перенесён. Доля шумных токенов донора ложно срабатывает на марках строительных
// материалов (смета Locus «Материалы»: 0,115 при нормальном тексте) и оставлена только диагностикой.
// Значения входят в конфигурацию распознавателя: их смена даёт новый отпечаток прогона (AD-05a-2).
export interface IQualityGate {
  // Страница PDF с достаточным текстовым слоем: OCR не нужен (OD-5).
  nativeMinChars: number;
  nativeMinWords: number;
  // Доля символов замены U+FFFD: сломанная кодировка текста (донор: encoding_noise).
  maxReplacementRatio: number;
  // Страница OCR: меньше этого текста — «пусто» (missing).
  ocrMinChars: number;
  ocrMinWords: number;
  ocrMinLetterRatio: number;
  // Уверенность движка — один из критериев, не единственный: ниже review — «требует проверки»,
  // ниже unreadable — текст непригоден и в доказательства не идёт.
  ocrReviewConfidence: number;
  ocrUnreadableConfidence: number;
}

export const QUALITY_GATE: IQualityGate = {
  nativeMinChars: 20,
  nativeMinWords: 3,
  maxReplacementRatio: 0.01,
  ocrMinChars: 20,
  ocrMinWords: 3,
  ocrMinLetterRatio: 0.2,
  ocrReviewConfidence: 80,
  ocrUnreadableConfidence: 40,
};

// Текстовый слой страницы PDF пригоден, если текста достаточно и кодировка не сломана.
export const nativeLayerUsable = (m: ITextMetrics, g: IQualityGate = QUALITY_GATE): { usable: boolean; issues: string[] } => {
  const issues: string[] = [];
  if (m.replacementRatio > g.maxReplacementRatio) issues.push('encoding_noise');
  if (m.chars < g.nativeMinChars || m.words < g.nativeMinWords) issues.push('text_layer_insufficient');
  return { usable: issues.length === 0, issues };
};

// Статус страницы после OCR: пусто — missing; мусор — failed (в доказательства не идёт);
// текст ниже шлюза — needs_review; иначе — recognized.
export const ocrPageStatus = (
  m: ITextMetrics,
  confidence: number | null,
  g: IQualityGate = QUALITY_GATE,
): { status: LocalUnitStatus; issues: string[] } => {
  if (m.chars < g.ocrMinChars || m.words < g.ocrMinWords) return { status: 'missing', issues: ['ocr_empty'] };
  if (confidence === null || confidence < g.ocrUnreadableConfidence) return { status: 'failed', issues: ['ocr_unreadable'] };
  const issues: string[] = [];
  if (m.replacementRatio > g.maxReplacementRatio) issues.push('encoding_noise');
  if (m.letterRatio < g.ocrMinLetterRatio) issues.push('low_text_density');
  if (confidence < g.ocrReviewConfidence) issues.push('low_ocr_confidence');
  return { status: issues.length === 0 ? 'recognized' : 'needs_review', issues };
};

// Извлечённый структурный текст (DOCX, XLSX, CSV): признаки сломанной кодировки — needs_review.
export const structuredUnitIssues = (m: ITextMetrics, g: IQualityGate = QUALITY_GATE): string[] =>
  m.replacementRatio > g.maxReplacementRatio ? ['encoding_noise'] : [];
