// Настройки распознавателя из конфигурации процесса: одинаковы у сервера (команда) и worker
// (автоматический проход и выполнение), поэтому описание и отпечаток совпадают (AD-05a-2).
import type { ILocalOcrEngineFactory } from './ocr.ts';
import type { ILocalRecognizerSettings } from './recognizer.ts';
import { DEFAULT_LOCAL_LIMITS, type ILocalLimits, type LocalInputFormat } from './types.ts';

export interface ILocalConfigShape {
  localRecognition: {
    ocrEngine: 'tesseract_js' | 'none';
    ocrDpi: number;
    ocrPageTimeoutMs: number;
    maxInputBytes: number;
    maxUnzippedBytes: number;
    maxCells: number;
    maxOcrPages: number;
  };
  recognition: { maxPdfBytes: number; maxPages: number; maxTotalTextChars: number };
  limits: { maxCompressionRatio: number; maxArchiveEntries: number };
}

export interface ILocalSettings extends ILocalRecognizerSettings {
  ocrPageTimeoutMs: number;
  limitsFor: (format: LocalInputFormat) => ILocalLimits;
}

// ocr — фабрика движка, выбранная процессом по конфигурации (packages/storage, localOcrFactory); null — без OCR.
export const localSettings = (c: ILocalConfigShape, ocr: ILocalOcrEngineFactory | null): ILocalSettings => {
  const l = c.localRecognition;
  const limits: ILocalLimits = {
    ...DEFAULT_LOCAL_LIMITS,
    maxInputBytes: l.maxInputBytes,
    maxUnzippedBytes: l.maxUnzippedBytes,
    maxPartBytes: l.maxUnzippedBytes,
    maxCompressionRatio: c.limits.maxCompressionRatio,
    maxZipEntries: c.limits.maxArchiveEntries,
    maxCells: l.maxCells,
    maxPages: c.recognition.maxPages,
    maxOcrPages: l.maxOcrPages,
    maxTotalTextChars: c.recognition.maxTotalTextChars,
  };
  return {
    ocr,
    ocrDpi: l.ocrDpi,
    ocrPageTimeoutMs: l.ocrPageTimeoutMs,
    limits,
    limitsFor: (format) => (format === 'pdf' ? { ...limits, maxInputBytes: c.recognition.maxPdfBytes } : limits),
  };
};
