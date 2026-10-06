// Разбор размеченной копии образца (этап 12; D-032 В-12-3; ADR-013 п. 2): формат по содержимому (только DOCX и XLSX),
// теги разметки, проверка по схеме ревизии. Итог хранится в ревизии; с ошибками ревизия не утверждается.
import { scanDocxTags, scanXlsxTags, detectFormat, OfficeError } from '@kontur/adapters';
import { checkMarkup, type IFormSchema, type IMarkupResult } from '@kontur/core';
import type { BlobStore } from '@kontur/storage';
import { HttpError } from './http/errors.ts';

export const readStoredBlob = async (store: BlobStore, sha256: string): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const ch of store.openRead(sha256)) chunks.push(ch as Buffer);
  return Buffer.concat(chunks);
};

export const analyzeMarkedSample = async (store: BlobStore, sha256: string, schema: IFormSchema): Promise<{ format: 'docx' | 'xlsx'; markup: IMarkupResult }> => {
  if (!(await store.exists(sha256))) throw new HttpError(400, 'VALIDATION_FAILED', 'размеченный образец не загружен');
  const bytes = await readStoredBlob(store, sha256);
  const format = detectFormat(bytes);
  if (format !== 'docx' && format !== 'xlsx') {
    throw new HttpError(400, 'VALIDATION_FAILED', 'размеченный образец — DOCX или XLSX (ADR-013)', { errors: [{ path: 'markedSample', message: `формат: ${format ?? 'не определён'}` }] });
  }
  try {
    return { format, markup: checkMarkup(schema, format, format === 'docx' ? scanDocxTags(bytes) : scanXlsxTags(bytes)) };
  } catch (err) {
    if (err instanceof OfficeError) throw new HttpError(400, 'VALIDATION_FAILED', `размеченный образец не читается: ${err.message}`);
    throw err;
  }
};
