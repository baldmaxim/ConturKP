// PDF в локальном распознавании (этап 05a, OD-5, OD-6): сначала встроенный текстовый слой, OCR —
// только для страниц без пригодного текста; качество страницы — по шлюзу; итог прогона — complete,
// needs_review (partial) или failed. OCR — настоящий tesseract.js с моделями rus и eng без сети;
// отказы движка — подставной фабрикой. Фикстуры — tests/fixtures/local/*.pdf.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_LIMITS,
  LocalRecognitionError,
  outcomeOf,
  recognizeLocal,
  createTesseractJsFactory,
  type ILocalOcrEngineFactory,
  type ILocalRunOptions,
} from '../packages/adapters/src/index.ts';
import { prepareTesseractModels } from '../packages/storage/src/index.ts';

const tesseractJsFactory = createTesseractJsFactory(prepareTesseractModels);

const pdf = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', 'local', `${name}.pdf`));

const run = (bytes: Buffer, o: Partial<ILocalRunOptions> = {}) =>
  recognizeLocal({ format: 'pdf', bytes, limits: DEFAULT_LOCAL_LIMITS, ocr: tesseractJsFactory, ocrDpi: 200, ocrPageTimeoutMs: 60_000, throwIfStopped: () => undefined, ...o });

// Подставной движок: считает создания и отвечает заданным результатом или ошибкой.
const fakeOcr = (answer: () => Promise<{ text: string; confidence: number }>): ILocalOcrEngineFactory & { created: number } => {
  const f = {
    created: 0,
    describe: async () => ({ engineId: 'fake', engineVersion: '0', coreVersion: '0', oem: 'x', engineLanguages: 'rus+eng', models: [] }),
    create: async () => {
      f.created += 1;
      return {
        recognize: async () => {
          const a = await answer();
          return { text: a.text, blocks: [{ text: a.text, confidence: a.confidence }], confidence: a.confidence, words: a.text.split(/\s+/).length };
        },
        close: async () => undefined,
      };
    },
  };
  return f;
};

describe('PDF: текстовый слой и OCR', () => {
  it('текстовый PDF — встроенный текст, OCR не запускается (OD-5)', async () => {
    const spy = fakeOcr(async () => ({ text: 'не должен вызываться', confidence: 99 }));
    const r = await run(pdf('letter-text'), { ocr: spy });
    expect(spy.created).toBe(0);
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ kind: 'pdf_page', method: 'native_text', status: 'recognized', label: '1' });
    expect(r.units[0]!.widthPx).toBeGreaterThan(0);
    expect(r.fragments.every((f) => f.origin === 'document_text' && f.locator.kind === 'pdf_text' && f.locator.method === 'native_text')).toBe(true);
    expect(r.fragments.map((f) => f.text).join('\n')).toContain('Стромынка');
    expect(outcomeOf(r)).toMatchObject({ status: 'complete', pagesTotal: 1, pagesRecognized: 1 });
  });

  it('скан без текстового слоя — OCR tesseract.js: распознанный текст, уверенность выше шлюза', async () => {
    const r = await run(pdf('letter-scan'));
    expect(r.units[0]).toMatchObject({ method: 'ocr', status: 'recognized' });
    expect(r.units[0]!.metrics.ocrConfidence).toBeGreaterThanOrEqual(80);
    expect(r.fragments.every((f) => f.origin === 'recognized_text' && f.locator.kind === 'pdf_text' && f.locator.method === 'ocr')).toBe(true);
    const text = r.fragments.map((f) => f.text).join('\n');
    expect(text).toContain('Стромынка');
    expect(text).toContain('01.07.2026');
  }, 60_000);

  it('смешанный PDF: страница 1 — текстовый слой, страница 2 — OCR; якоря воспроизводимы', async () => {
    const a = await run(pdf('mixed'));
    expect(a.units.map((u) => [u.method, u.status])).toEqual([
      ['native_text', 'recognized'],
      ['ocr', 'recognized'],
    ]);
    expect(new Set(a.fragments.map((f) => `${f.locator.kind === 'pdf_text' ? f.locator.page : 0}:${f.origin}`))).toEqual(
      new Set(['1:document_text', '2:recognized_text']),
    );
    const b = await run(pdf('mixed'));
    expect(b.fragments.map((f) => [f.key, f.locator, f.text])).toEqual(a.fragments.map((f) => [f.key, f.locator, f.text]));
  }, 60_000);

  it('пустая страница — missing; пригодного текста нет — failed no_usable_text (OD-6)', async () => {
    const r = await run(pdf('blank'));
    expect(r.units[0]).toMatchObject({ status: 'missing', issues: ['text_layer_insufficient', 'ocr_empty'] });
    expect(outcomeOf(r)).toMatchObject({ status: 'failed', code: 'no_usable_text' });
  }, 60_000);

  it('шум вместо текста — страница нечитаема, мусор OCR в доказательства не идёт', async () => {
    const r = await run(pdf('noise'));
    expect(r.units[0]).toMatchObject({ status: 'failed', issues: ['text_layer_insufficient', 'ocr_unreadable'] });
    expect(r.fragments).toHaveLength(0);
    expect(outcomeOf(r)).toMatchObject({ status: 'failed', code: 'no_usable_text' });
  }, 90_000);

  it('текст ниже шлюза — needs_review с сохранённым текстом; прогон partial (OD-6)', async () => {
    const low = fakeOcr(async () => ({ text: 'Генподрядчик приостанавливает работы с 01.07.2026 до получения документации', confidence: 55 }));
    const r = await run(pdf('mixed'), { ocr: low });
    expect(r.units[1]).toMatchObject({ method: 'ocr', status: 'needs_review', issues: ['text_layer_insufficient', 'low_ocr_confidence'] });
    expect(r.units[1]!.metrics.ocrConfidence).toBe(55);
    expect(r.fragments.some((f) => f.unitIndex === 1)).toBe(true);
    expect(outcomeOf(r)).toMatchObject({ status: 'partial', pagesTotal: 2, pagesRecognized: 1 });
  });

  it('OCR не настроен: скан — missing с ocr_unavailable, прогон failed ocr_unavailable', async () => {
    const r = await run(pdf('letter-scan'), { ocr: null });
    expect(r.units[0]).toMatchObject({ status: 'missing', issues: ['ocr_unavailable'] });
    expect(outcomeOf(r)).toMatchObject({ status: 'failed', code: 'ocr_unavailable' });
    // Смешанный документ без OCR: текстовая страница распознана, скан — нет: требует проверки.
    expect(outcomeOf(await run(pdf('mixed'), { ocr: null }))).toMatchObject({ status: 'partial', pagesRecognized: 1 });
  });

  it('движок упал или завис — страница failed, прогон без неё; таймаут страницы соблюдается', async () => {
    const broken = fakeOcr(async () => {
      throw new Error('движок недоступен');
    });
    const r = await run(pdf('mixed'), { ocr: broken });
    expect(r.units[1]).toMatchObject({ status: 'failed', issues: ['text_layer_insufficient', 'ocr_page_failed'] });
    const hung = fakeOcr(() => new Promise(() => undefined));
    const t = await run(pdf('mixed'), { ocr: hung, ocrPageTimeoutMs: 200 });
    expect(t.units[1]!.status).toBe('failed');
  });

  it('отмена между страницами не глотается конвейером', async () => {
    let pages = 0;
    const stop = Object.assign(new Error('отмена запрошена'), { name: 'JobCancelledError' });
    await expect(
      run(pdf('mixed'), {
        ocr: null,
        throwIfStopped: () => {
          pages += 1;
          if (pages === 2) throw stop;
        },
      }),
    ).rejects.toBe(stop);
  });

  it('пределы страниц, OCR-страниц и размера файла — too_large (тест 18); повреждённый PDF — pdf_unreadable', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof LocalRecognitionError ? e.code : String(e)));
    expect(await code(run(pdf('mixed'), { limits: { ...DEFAULT_LOCAL_LIMITS, maxPages: 1 } }))).toBe('too_large');
    expect(await code(run(pdf('mixed'), { limits: { ...DEFAULT_LOCAL_LIMITS, maxOcrPages: 0 } }))).toBe('too_large');
    expect(await code(run(pdf('mixed'), { limits: { ...DEFAULT_LOCAL_LIMITS, maxInputBytes: 1000 } }))).toBe('too_large');
    expect(await code(run(Buffer.from('%PDF-1.7\nэто не PDF'), {}))).toBe('pdf_unreadable');
  });
});
