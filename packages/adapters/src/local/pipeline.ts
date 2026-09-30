// Конвейер локального распознавания: формат → разборщик. У PDF сначала встроенный текстовый слой,
// OCR — только для страниц без пригодного текста (OD-5); отмена и потеря аренды проверяются между
// страницами (ADR-004 §7b). Итог прогона выводится из единиц (OD-6): все прошли шлюз — complete,
// есть пригодный текст и проблемные единицы — needs_review, пригодного текста нет — failed.
import { splitFragmentText } from '../rdweb/import.ts';
import { parseCsv } from './csv.ts';
import { parseDocx } from './docx.ts';
import type { ILocalOcrEngine, ILocalOcrEngineFactory } from './ocr.ts';
import { nativeBlocks, openPdf, pageSizePx, renderPagePng } from './pdf.ts';
import { nativeLayerUsable, normalizeLocalText, ocrPageStatus, textMetrics } from './quality.ts';
import {
  LocalRecognitionError,
  type ILocalFragment,
  type ILocalLimits,
  type ILocalResult,
  type ILocalUnit,
  type LocalFailureCode,
  type LocalInputFormat,
} from './types.ts';
import { parseXlsx } from './xlsx.ts';

export interface ILocalRunOptions {
  format: LocalInputFormat;
  bytes: Buffer;
  limits: ILocalLimits;
  ocr: ILocalOcrEngineFactory | null;
  ocrDpi: number;
  ocrPageTimeoutMs: number;
  throwIfStopped: () => void;
}

const OCR_MAX_CONSECUTIVE_FAILURES = 3;

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new LocalRecognitionError('ocr_failed', `OCR страницы дольше ${ms} мс`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const pushBlocks = (
  out: ILocalFragment[],
  blocks: string[],
  page: number,
  method: 'native_text' | 'ocr',
  limits: ILocalLimits,
  total: { chars: number },
): void => {
  let block = 0;
  for (const raw of blocks) {
    const text = normalizeLocalText(raw);
    if (text === '') continue;
    block += 1;
    total.chars += text.length;
    if (total.chars > limits.maxTotalTextChars) throw new LocalRecognitionError('too_large', 'текст документа больше предела разбора');
    const parts = splitFragmentText(text, limits.maxFragmentChars);
    for (const [i, part] of parts.entries()) {
      out.push({
        unitIndex: page - 1,
        key: parts.length > 1 ? `p${page}:b${block}#p${i + 1}` : `p${page}:b${block}`,
        ordinal: out.length + 1,
        origin: method === 'ocr' ? 'recognized_text' : 'document_text',
        text: part,
        locator: { kind: 'pdf_text', page, method, block },
        warnings: parts.length > 1 ? ['text_split'] : [],
        partIndex: i,
        partTotal: parts.length,
      });
    }
  }
};

const recognizePdf = async (o: ILocalRunOptions): Promise<ILocalResult> => {
  if (o.bytes.length > o.limits.maxInputBytes) throw new LocalRecognitionError('too_large', `файл ${o.bytes.length} байт больше предела ${o.limits.maxInputBytes}`);
  const doc = await openPdf(new Uint8Array(o.bytes));
  const units: ILocalUnit[] = [];
  const fragments: ILocalFragment[] = [];
  const total = { chars: 0 };
  let engine: ILocalOcrEngine | null = null;
  let ocrPages = 0;
  let consecutiveFailures = 0;
  try {
    if (doc.numPages > o.limits.maxPages) throw new LocalRecognitionError('too_large', `в PDF ${doc.numPages} страниц, предел — ${o.limits.maxPages}`);
    for (let n = 1; n <= doc.numPages; n += 1) {
      o.throwIfStopped();
      const page = await doc.getPage(n);
      try {
        const size = pageSizePx(page, o.ocrDpi);
        const native = await nativeBlocks(page);
        const nm = textMetrics(native.join('\n'));
        const check = nativeLayerUsable(nm);
        const unit: ILocalUnit = {
          index: n - 1,
          kind: 'pdf_page',
          label: String(n),
          widthPx: size.width,
          heightPx: size.height,
          rotation: size.rotation,
          status: 'recognized',
          method: 'native_text',
          metrics: { ...nm, ocrConfidence: null, nativeChars: nm.chars },
          issues: [],
        };
        if (check.usable) {
          pushBlocks(fragments, native, n, 'native_text', o.limits, total);
        } else if (o.ocr) {
          ocrPages += 1;
          if (ocrPages > o.limits.maxOcrPages) throw new LocalRecognitionError('too_large', `OCR нужен больше чем ${o.limits.maxOcrPages} страницам`);
          unit.method = 'ocr';
          try {
            engine ??= await o.ocr.create();
            const png = await renderPagePng(page, o.ocrDpi);
            o.throwIfStopped();
            const res = await withTimeout(engine.recognize(png), o.ocrPageTimeoutMs);
            consecutiveFailures = 0;
            const blocks = res.blocks.map((b) => b.text);
            const om = textMetrics(blocks.join('\n'));
            const st = ocrPageStatus(om, res.confidence);
            unit.status = st.status;
            unit.metrics = { ...om, ocrConfidence: res.confidence, nativeChars: nm.chars };
            unit.issues = [...check.issues, ...st.issues];
            // Пустая и нечитаемая страница доказательств не даёт: мусор OCR в поиск не попадает.
            if (st.status === 'recognized' || st.status === 'needs_review') pushBlocks(fragments, blocks, n, 'ocr', o.limits, total);
          } catch (err) {
            if (err instanceof LocalRecognitionError && err.code === 'too_large') throw err;
            if ((err as { name?: string }).name === 'JobCancelledError' || (err as { name?: string }).name === 'LeaseLostError') throw err;
            consecutiveFailures += 1;
            // Движок мог упасть: следующая страница создаёт его заново.
            await engine?.close().catch(() => undefined);
            engine = null;
            unit.status = 'failed';
            unit.issues = [...check.issues, 'ocr_page_failed'];
            if (consecutiveFailures >= OCR_MAX_CONSECUTIVE_FAILURES) {
              throw new LocalRecognitionError('ocr_failed', `OCR не удался на ${consecutiveFailures} страницах подряд: ${(err as Error).message.slice(0, 200)}`);
            }
          }
        } else if (nm.chars > 0) {
          // Слабый текстовый слой без OCR: текст сохраняется, страница требует проверки.
          unit.status = 'needs_review';
          unit.issues = [...check.issues, 'ocr_unavailable'];
          pushBlocks(fragments, native, n, 'native_text', o.limits, total);
        } else {
          unit.status = 'missing';
          unit.issues = ['ocr_unavailable'];
        }
        units.push(unit);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await engine?.close().catch(() => undefined);
    await doc.destroy().catch(() => undefined);
  }
  return { units, fragments, skipped: {}, warnings: [], facts: { pages: units.length, ocrPages } };
};

export const recognizeLocal = async (o: ILocalRunOptions): Promise<ILocalResult> => {
  switch (o.format) {
    case 'docx':
      return parseDocx(o.bytes, o.limits);
    case 'xlsx':
      return parseXlsx(o.bytes, o.limits);
    case 'csv':
      return parseCsv(o.bytes, o.limits);
    case 'pdf':
      return recognizePdf(o);
  }
};

export type LocalOutcome = { status: 'complete' | 'partial'; pagesTotal: number; pagesRecognized: number } | { status: 'failed'; code: LocalFailureCode; detail: string };

// Итог прогона по единицам (OD-6). Пригодного фрагмента нет — failed: у скана без OCR — ocr_unavailable.
export const outcomeOf = (r: ILocalResult): LocalOutcome => {
  const recognized = r.units.filter((u) => u.status === 'recognized').length;
  if (r.fragments.length === 0 || r.units.length === 0) {
    const noOcr = r.units.length > 0 && r.units.every((u) => u.issues.includes('ocr_unavailable'));
    const counts = `единиц ${r.units.length}, пригодных фрагментов нет`;
    return noOcr
      ? { status: 'failed', code: 'ocr_unavailable', detail: `${counts}: страницам нужен OCR, а движок не настроен` }
      : { status: 'failed', code: 'no_usable_text', detail: counts };
  }
  return { status: recognized === r.units.length ? 'complete' : 'partial', pagesTotal: r.units.length, pagesRecognized: recognized };
};
