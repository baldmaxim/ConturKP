// Модели локального OCR (этап 05a, OD-5): сжатые traineddata rus и eng из npm-пакетов
// @tesseract.js-data (версия закреплена package-lock, целостность проверяет npm). Этот пакет читает
// файлы и раскладывает их в один локальный каталог, которого ждёт движок; адаптер OCR сам к диску
// и сети не обращается (A38). Каталог назван по отпечатку моделей: повторный запуск и второй процесс
// используют тот же каталог, запись — через временный файл и переименование.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createTesseractJsFactory,
  OCR_LANGUAGES,
  TESSERACT_MODEL_VARIANT,
  type ILocalOcrEngineFactory,
  type IOcrModelBytes,
  type IOcrModelSet,
} from '@kontur/adapters';

const require = createRequire(import.meta.url);

export const readTesseractModels = async (): Promise<IOcrModelBytes[]> =>
  Promise.all(
    OCR_LANGUAGES.map(async (lang) => {
      const dir = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
      return { lang, variant: TESSERACT_MODEL_VARIANT, bytes: new Uint8Array(await readFile(join(dir, TESSERACT_MODEL_VARIANT, `${lang}.traineddata.gz`))) };
    }),
  );

export const prepareTesseractModels = async (): Promise<IOcrModelSet> => {
  const models = await readTesseractModels();
  const digest = createHash('sha256');
  for (const m of models) digest.update(m.lang).update(m.bytes);
  const langPath = join(tmpdir(), 'kontur-ocr-models', digest.digest('hex').slice(0, 16));
  await mkdir(langPath, { recursive: true });
  for (const m of models) {
    const target = join(langPath, `${m.lang}.traineddata.gz`);
    const current = await stat(target).catch(() => null);
    if (current?.size === m.bytes.length) continue;
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, m.bytes);
    await rename(tmp, target);
  }
  return { langPath, models };
};

// Движок по конфигурации процесса (LOCAL_OCR_ENGINE): tesseract_js или без OCR.
export const localOcrFactory = (kind: 'tesseract_js' | 'none'): ILocalOcrEngineFactory | null =>
  kind === 'tesseract_js' ? createTesseractJsFactory(prepareTesseractModels) : null;
