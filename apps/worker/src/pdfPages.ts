// Достоверное число страниц локального оригинала (ревью 04-1, R04-03). Полнота распознавания
// меряется по самому PDF, а не по согласованности файлов экспорта: архив, «забывший» страницу,
// обязан давать неполноту, а не тихий complete (I18).
//
// Движок — pdfjs-dist, тот же, которым портал показывает участок доказательства в браузере
// (A17, D-011). Отдельной записи в цепочке поставки не появляется, а оригинал, который pdf.js
// не открывает, всё равно нечем показать — поэтому такой прогон честно получает отказ.
// Сети у разбора нет: шрифты и стандартные данные не догружаются, скриптов в PDF pdf.js
// не исполняет (enableScripting по умолчанию выключен, eval в pdf.js 5 не используется).
import { readFile, stat } from 'node:fs/promises';

export class PdfTooLargeError extends Error {}
export class PdfUnreadableError extends Error {}

export const pdfPageCountOfBytes = async (bytes: Uint8Array): Promise<number> => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    await doc.destroy();
    if (!Number.isInteger(pages) || pages < 1) throw new PdfUnreadableError('число страниц оригинала не определено');
    return pages;
  } catch (err) {
    if (err instanceof PdfUnreadableError) throw err;
    throw new PdfUnreadableError(`оригинал не открывается pdf.js: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    await task.destroy().catch(() => undefined);
  }
};

export const pdfPageCount = async (path: string, maxBytes: number): Promise<number> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    throw new PdfUnreadableError(`оригинал не читается: ${(err as Error).message.slice(0, 200)}`);
  }
  if (size > maxBytes) throw new PdfTooLargeError(`оригинал ${size} байт больше предела ${maxBytes} байт`);
  return pdfPageCountOfBytes(new Uint8Array(await readFile(path)));
};
