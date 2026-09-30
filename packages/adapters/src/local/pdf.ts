// PDF для локального распознавания: встроенный текстовый слой страницы и растр страницы для OCR.
// Движок — pdfjs-dist, тот же, что считает страницы оригинала на этапе 04 и показывает участок
// в браузере. Сети нет: шрифты и данные не догружаются, скрипты PDF не исполняются.
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { LocalRecognitionError } from './types.ts';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));

export const pdfjsVersion = (): string => (require('pdfjs-dist/package.json') as { version: string }).version;

export const openPdf = async (bytes: Uint8Array): Promise<PDFDocumentProxy> => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
    standardFontDataUrl: `${join(pdfjsRoot, 'standard_fonts')}${sep}`,
  });
  try {
    return await task.promise;
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    await task.destroy().catch(() => undefined);
    if (name === 'PasswordException') throw new LocalRecognitionError('pdf_unreadable', 'PDF защищён паролем');
    throw new LocalRecognitionError('pdf_unreadable', `PDF не открывается: ${(err as Error).message.slice(0, 200)}`);
  }
};

interface ITextItem {
  str: string;
  hasEOL: boolean;
  transform: number[];
  height: number;
}

interface ILine {
  text: string;
  y: number;
  height: number;
}

// Текстовый слой страницы → блоки. Строка заканчивается признаком конца строки pdf.js; новый блок
// начинается после вертикального промежутка больше 1,8 высоты строки или при переходе вверх (колонка).
export const nativeBlocks = async (page: PDFPageProxy): Promise<string[]> => {
  const content = await page.getTextContent();
  const lines: ILine[] = [];
  let current = '';
  let y: number | null = null;
  let height = 0;
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const item = raw as unknown as ITextItem;
    if (y === null) y = item.transform[5] ?? 0;
    current += item.str;
    height = Math.max(height, Math.abs(item.height || item.transform[3] || 0));
    if (item.hasEOL) {
      lines.push({ text: current, y, height });
      current = '';
      y = null;
      height = 0;
    }
  }
  if (current !== '' || y !== null) lines.push({ text: current, y: y ?? 0, height });
  const heights = lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 12;
  const blocks: string[] = [];
  let block: string[] = [];
  let prevY: number | null = null;
  for (const line of lines) {
    const gap = prevY === null ? 0 : prevY - line.y;
    if (block.length > 0 && (gap > typical * 1.8 || gap < -typical * 0.5 || line.text.trim() === '')) {
      blocks.push(block.join('\n'));
      block = [];
    }
    if (line.text.trim() !== '') block.push(line.text);
    prevY = line.y;
  }
  if (block.length > 0) blocks.push(block.join('\n'));
  return blocks;
};

// Размер страницы в пикселях растра при DPI распознавателя — и для страниц, которые не растрировались.
export const pageSizePx = (page: PDFPageProxy, dpi: number): { width: number; height: number; rotation: number } => {
  const vp = page.getViewport({ scale: 1 });
  const rotation = ((page.rotate % 360) + 360) % 360;
  return { width: Math.max(1, Math.round((vp.width * dpi) / 72)), height: Math.max(1, Math.round((vp.height * dpi) / 72)), rotation };
};

// Растр страницы для OCR (PNG). Предел пикселей защищает память от огромного формата листа.
const MAX_PIXELS = 60_000_000;

export const renderPagePng = async (page: PDFPageProxy, dpi: number): Promise<Buffer> => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Холст @napi-rs/canvas совместим с интерфейсом, которого ждёт pdf.js в Node; типов DOM в сборке сервера нет.
  await page.render({ canvasContext: ctx, viewport: vp, canvas } as unknown as Parameters<PDFPageProxy['render']>[0]).promise;
  return canvas.toBuffer('image/png');
};
