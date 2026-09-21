// Хэш состава ревизии набора источников (data-model §4.3, state-machines §5).
// В хэш входит только состав: какие редакции включены и с каким решением. Прогоны
// распознавания в него НЕ входят — их фиксирует снимок области доказательств
// (evidence_scope, этап 05), иначе одна и та же ревизия меняла бы хэш при новом OCR.
import { createHash } from 'node:crypto';

const VERSION_PREFIX = 'kontur.source_set.v1';

export interface IContentHashItem {
  documentRevisionId: string;
  blobSha256: string;
  inclusion: string;
}

// Порядок элементов на хэш не влияет: сортировка по идентификатору редакции.
export const sourceSetContentHash = (items: IContentHashItem[]): string => {
  const rows = [...items]
    .map((i) => [i.documentRevisionId, i.blobSha256, i.inclusion])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return createHash('sha256').update(`${VERSION_PREFIX}\n${JSON.stringify(rows)}`, 'utf8').digest('hex');
};
