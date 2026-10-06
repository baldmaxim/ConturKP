// Разбор PDF-превью (D-032 В-12-2, В-12-10): число страниц, текст каждой страницы, шрифты (имя и признак встраивания),
// производитель; снимки страниц PNG для просмотра человеком. Движок — pdf.js, тот же, что в распознавании (этап 05a).
import type { PDFPageProxy } from 'pdfjs-dist';
import { openPdf, renderPagePng } from '../local/pdf.ts';
import { OfficeError } from './ooxml.ts';

export interface IPdfFont {
  name: string;
  embedded: boolean;
}

export interface IPdfInspection {
  pages: number;
  pageTexts: string[];
  fonts: IPdfFont[];
  producer: string | null;
}

const pageFonts = async (page: PDFPageProxy, setFont: number): Promise<IPdfFont[]> => {
  const ops = await page.getOperatorList();
  const ids = new Set<string>();
  ops.fnArray.forEach((fn, i) => {
    if (fn === setFont) ids.add(String(ops.argsArray[i]?.[0]));
  });
  const out: IPdfFont[] = [];
  for (const id of ids) {
    const f = page.commonObjs.has(id) ? (page.commonObjs.get(id) as { name?: string; missingFile?: boolean } | null) : null;
    if (f?.name) out.push({ name: f.name, embedded: f.missingFile !== true });
  }
  return out;
};

export const inspectPdf = async (bytes: Buffer): Promise<IPdfInspection> => {
  let doc;
  try {
    doc = await openPdf(new Uint8Array(bytes));
  } catch (err) {
    throw new OfficeError('conversion_failed', `PDF превью не открывается: ${(err as Error).message.slice(0, 200)}`);
  }
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pageTexts: string[] = [];
    const fonts = new Map<string, IPdfFont>();
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((x) => ('str' in x ? `${x.str}${x.hasEOL ? '\n' : ''}` : '')).join(''));
      for (const f of await pageFonts(page, pdfjs.OPS.setFont)) fonts.set(f.name, { name: f.name, embedded: (fonts.get(f.name)?.embedded ?? true) && f.embedded });
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    const producer = (meta?.info as { Producer?: string } | undefined)?.Producer ?? null;
    return { pages: doc.numPages, pageTexts, fonts: [...fonts.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), producer };
  } finally {
    await doc.destroy();
  }
};

export const renderPdfPages = async (bytes: Buffer, dpi = 96, maxPages = 50): Promise<Buffer[]> => {
  const doc = await openPdf(new Uint8Array(bytes));
  try {
    const out: Buffer[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i += 1) out.push(await renderPagePng(await doc.getPage(i), dpi));
    return out;
  } finally {
    await doc.destroy();
  }
};
