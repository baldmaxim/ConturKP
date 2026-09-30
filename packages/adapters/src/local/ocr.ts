// Контракт OCR-движка (OD-5): доменная модель не зависит от конкретного движка. Описание фиксирует
// идентификатор и версию движка, модели с их SHA-256, языки и параметры — оно входит в конфигурацию
// распознавателя и отпечаток прогона (AD-05a-2).
//
// Первый рабочий адаптер — tesseract.js (Apache-2.0): WASM-сборка Tesseract внутри процесса worker
// (worker_threads), ставится вместе с приложением через npm и работает на Windows без отдельной
// установки. Модели rus и eng (tessdata best_int из npm-пакетов @tesseract.js-data) готовит загрузчик
// (packages/storage): байты — для отпечатка, локальный каталог — для движка. Сам адаптер файлов не
// читает и в сеть не ходит (A38): langPath — локальный каталог, кеш выключен. Донор — Locus
// (apps/rag-api/src/converters.js, getOcrWorker): там модели догружались из CDN, здесь это исключено.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface IOcrModel {
  lang: string;
  variant: string;
  sha256: string;
}

export interface ILocalOcrDescriptor {
  engineId: string;
  engineVersion: string;
  coreVersion: string;
  oem: string;
  // Порядок языков для движка: первый — основной.
  engineLanguages: string;
  models: IOcrModel[];
}

export interface IOcrBlock {
  text: string;
  confidence: number | null;
}

export interface IOcrPageResult {
  text: string;
  blocks: IOcrBlock[];
  // Средняя уверенность движка по словам страницы, 0–100.
  confidence: number | null;
  words: number;
}

export interface ILocalOcrEngine {
  recognize: (png: Buffer) => Promise<IOcrPageResult>;
  close: () => Promise<void>;
}

export interface ILocalOcrEngineFactory {
  describe: () => Promise<ILocalOcrDescriptor>;
  create: () => Promise<ILocalOcrEngine>;
}

// Языки этапа 05a — только русский и английский (OD-5).
export const OCR_LANGUAGES = ['eng', 'rus'] as const;
const ENGINE_LANGUAGES = 'rus+eng';
export const TESSERACT_MODEL_VARIANT = '4.0.0_best_int';

// Байты модели от загрузчика: сжатый traineddata одного языка.
export interface IOcrModelBytes {
  lang: string;
  variant: string;
  bytes: Uint8Array;
}

// Набор моделей: байты для отпечатка и локальный каталог, где лежат те же файлы для движка.
export interface IOcrModelSet {
  langPath: string;
  models: IOcrModelBytes[];
}

const versionOf = (pkg: string): string => (require(`${pkg}/package.json`) as { version: string }).version;

interface ITesseractWord {
  confidence: number;
}
interface ITesseractParagraph {
  text: string;
  confidence: number;
  lines: { words: ITesseractWord[] }[];
}
interface ITesseractBlock {
  paragraphs: ITesseractParagraph[];
}

export const createTesseractJsFactory = (loadModels: () => Promise<IOcrModelSet>): ILocalOcrEngineFactory => {
  let loaded: Promise<IOcrModelSet> | null = null;
  const models = (): Promise<IOcrModelSet> => {
    loaded ??= loadModels().catch((err: unknown) => {
      loaded = null;
      throw err;
    });
    return loaded;
  };
  return {
    describe: async () => ({
      engineId: 'tesseract.js',
      engineVersion: versionOf('tesseract.js'),
      coreVersion: versionOf('tesseract.js-core'),
      oem: 'lstm_only',
      engineLanguages: ENGINE_LANGUAGES,
      models: (await models()).models
        .map((m) => ({ lang: m.lang, variant: m.variant, sha256: createHash('sha256').update(m.bytes).digest('hex') }))
        .sort((a, b) => a.lang.localeCompare(b.lang)),
    }),
    create: async () => {
      const { createWorker, OEM } = await import('tesseract.js');
      const set = await models();
      const worker = await createWorker(ENGINE_LANGUAGES.split('+'), OEM.LSTM_ONLY, { langPath: set.langPath, cacheMethod: 'none', gzip: true });
      return {
        recognize: async (png: Buffer): Promise<IOcrPageResult> => {
          const r = await worker.recognize(png, {}, { text: true, blocks: true });
          const blocks = ((r.data.blocks ?? []) as unknown as ITesseractBlock[]).flatMap((b) => b.paragraphs);
          const words = blocks.flatMap((p) => p.lines.flatMap((l) => l.words));
          return {
            text: r.data.text ?? '',
            blocks: blocks.map((p) => ({ text: p.text, confidence: Number.isFinite(p.confidence) ? Math.round(p.confidence) : null })),
            confidence: words.length > 0 && Number.isFinite(r.data.confidence) ? Math.round(r.data.confidence) : null,
            words: words.length,
          };
        },
        close: async () => {
          await worker.terminate().catch(() => undefined);
        },
      };
    },
  };
};
