// Описание распознавателя — идентичность локального прогона (AD-05a-2): идентификатор и версия,
// формат, способ обработки, языки и конфигурация, от которой зависит результат (версии движков,
// SHA-256 моделей, шлюз качества, DPI, правила отображения чисел, предел фрагмента). Пути, имена
// файлов и временные каталоги сюда не входят. Отпечаток и хэш конфигурации считает БД (миграция 0014).
import { NUMBER_RENDERING_VERSION } from './numberFormat.ts';
import { OCR_LANGUAGES, type ILocalOcrEngineFactory } from './ocr.ts';
import { pdfjsVersion } from './pdf.ts';
import { QUALITY_GATE } from './quality.ts';
import type { ILocalLimits, LocalInputFormat, LocalProcessing } from './types.ts';

export const LOCAL_RECOGNIZER_ID = 'kontur.local';
// Меняется при изменении логики разбора: новая версия даёт новый прогон (тест 6 решения владельца).
export const LOCAL_RECOGNIZER_VERSION = '1';

export interface ILocalRecognizer {
  recognizerId: string;
  recognizerVersion: string;
  inputFormat: LocalInputFormat;
  processing: LocalProcessing;
  languages: string[];
  config: Record<string, unknown>;
}

export interface ILocalRecognizerSettings {
  ocr: ILocalOcrEngineFactory | null;
  ocrDpi: number;
  limits: ILocalLimits;
}

export const describeLocalRecognizer = async (format: LocalInputFormat, s: ILocalRecognizerSettings): Promise<ILocalRecognizer> => {
  const base = { recognizerId: LOCAL_RECOGNIZER_ID, recognizerVersion: LOCAL_RECOGNIZER_VERSION, inputFormat: format };
  if (format !== 'pdf') {
    return {
      ...base,
      processing: 'structured_parser',
      languages: [],
      config: {
        parser: format,
        maxReplacementRatio: QUALITY_GATE.maxReplacementRatio,
        maxFragmentChars: s.limits.maxFragmentChars,
        ...(format === 'xlsx' ? { numbers: NUMBER_RENDERING_VERSION } : {}),
      },
    };
  }
  const ocr = s.ocr ? await s.ocr.describe() : null;
  return {
    ...base,
    processing: ocr ? 'native_text+ocr' : 'native_text',
    languages: ocr ? [...OCR_LANGUAGES] : [],
    config: {
      pdfjs: pdfjsVersion(),
      gate: { ...QUALITY_GATE },
      maxFragmentChars: s.limits.maxFragmentChars,
      ...(ocr ? { ocr: { ...ocr, dpi: s.ocrDpi } } : { dpi: s.ocrDpi }),
    },
  };
};
