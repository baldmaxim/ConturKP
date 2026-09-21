// Обезличенная фикстура экспортного архива RDWeb. Данных заказчика в ней нет по построению:
// весь текст синтетический. Негативные варианты формата задаются параметрами, а не отдельными
// файлами, поэтому «повёрнутая страница», «чужой PDF» и «битый JSON» проверяются одним кодом.
import { createHash } from 'node:crypto';
import { buildZip, realPdf, type IZipEntry } from './zip.ts';

export interface IRdwebFixture {
  docName?: string;
  pages?: number;
  rotate90?: number[];
  // Страницы, которых нет в выводе: их блоки не попадают ни в md, ни в _blocks.json (A16).
  omitPagesInMd?: number[];
  unknownBlockTypes?: string[];
  polygonPages?: number[];
  stamps?: 'per-page' | 'none';
  cropUrls?: 'all' | 'none' | 'except-stamps';
  schemaVersion?: number;
  coordinateSpace?: string;
  pdf?: Buffer;
  omit?: ('pdf' | 'blocks' | 'md' | 'html')[];
  brokenJson?: boolean;
  extraMembers?: IZipEntry[];
  unsafeMember?: 'traversal' | 'symlink' | 'encrypted';
  hugeTextChars?: number;
  // Меняет содержимое архива, не меняя PDF: второй экспорт того же документа (A10).
  generatedAt?: string;
  cropUrlValue?: string;
}

export interface IRdwebExpected {
  pdfSha256: string;
  docName: string;
  pagesTotal: number;
  pagesRecognized: number;
  status: 'complete' | 'partial';
  missingPages: number[];
  textBlockIds: string[];
  imageBlockIds: string[];
  stampBlockIds: string[];
  unknownBlockIds: string[];
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface IBlockOut {
  block_id: string;
  ordinal: number;
  page_index: number;
  page_label: number;
  block_type: string;
  shape_type: string;
  polygon_points?: number[][];
  status: string;
  export_status: string;
  coords_norm: number[];
  crop_url: string;
}

export const buildRdwebExport = (o: IRdwebFixture = {}): { zip: Buffer; pdf: Buffer; expected: IRdwebExpected; blocksJson: string; resultsMd: string } => {
  const docName = o.docName ?? 'ТЗ-фикстура';
  const pageCount = o.pages ?? 4;
  const rotated = new Set(o.rotate90 ?? [1]);
  const omitted = new Set(o.omitPagesInMd ?? []);
  const polygonPages = new Set(o.polygonPages ?? []);
  const stamps = o.stamps ?? 'per-page';
  const cropMode = o.cropUrls ?? 'except-stamps';
  const cropValue = o.cropUrlValue ?? 'https://rdweb.example.internal/crops';
  const pagesOut = Array.from({ length: pageCount }, (_, i) => ({
    page_index: i,
    page_label: i + 1,
    width_px: rotated.has(i) ? 3508 : 2480,
    height_px: rotated.has(i) ? 2480 : 3508,
    rotation: rotated.has(i) ? 90 : 0,
  }));
  // PDF настоящий, и повороты его страниц совпадают с объявленными в экспорте: фикстура
  // проверяет не только разбор, но и отрисовку участка оригинала на pdf.js.
  const pdf = o.pdf ?? realPdf(pagesOut.map((p) => ({ rotate: p.rotation })), docName);

  const blocks: IBlockOut[] = [];
  const textBlockIds: string[] = [];
  const imageBlockIds: string[] = [];
  const stampBlockIds: string[] = [];
  const unknownBlockIds: string[] = [];
  let ordinal = 0;
  const mkBlock = (pageIndex: number, suffix: string, type: string): IBlockOut => {
    ordinal += 1;
    const id = `blk-${pageIndex}-${suffix}`;
    const isStamp = type === 'stamp';
    const polygon = polygonPages.has(pageIndex) && type === 'text';
    const b: IBlockOut = {
      block_id: id,
      ordinal,
      page_index: pageIndex,
      page_label: pageIndex + 1,
      block_type: type,
      shape_type: polygon ? 'polygon' : 'rectangle',
      status: 'recognized',
      export_status: 'recognized',
      coords_norm: [0.1, 0.12 + 0.2 * (ordinal % 3), 0.9, 0.3 + 0.2 * (ordinal % 3)],
      crop_url: cropMode === 'none' || (cropMode === 'except-stamps' && isStamp) ? '' : `${cropValue}/${id}.png`,
    };
    if (polygon) b.polygon_points = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]];
    return b;
  };

  for (let p = 0; p < pageCount; p += 1) {
    if (omitted.has(p)) continue;
    const text = mkBlock(p, 'txt', 'text');
    blocks.push(text);
    textBlockIds.push(text.block_id);
    const image = mkBlock(p, 'img', 'image');
    blocks.push(image);
    imageBlockIds.push(image.block_id);
    if (stamps === 'per-page') {
      const stamp = mkBlock(p, 'stamp', 'stamp');
      blocks.push(stamp);
      stampBlockIds.push(stamp.block_id);
    }
    if (p === 0) {
      for (const [i, type] of (o.unknownBlockTypes ?? []).entries()) {
        const u = mkBlock(p, `unk${i}`, type);
        blocks.push(u);
        unknownBlockIds.push(u.block_id);
      }
    }
  }

  const blocksDoc = {
    schema_version: o.schemaVersion ?? 1,
    document_id: 'fixture-doc',
    document_name: docName,
    document_path: `\\\\fixture\\${docName}.pdf`,
    generated_at: o.generatedAt ?? '2026-09-20T10:00:00Z',
    coordinate_space: o.coordinateSpace ?? 'normalized_page_top_left',
    pages: pagesOut,
    blocks,
  };
  const blocksJson = o.brokenJson ? '{"schema_version": 1, "pages": [' : JSON.stringify(blocksDoc, null, 1);

  // Штамп повторяется в каждой секции блоков страницы — как в образце (321 строка на 63 блока).
  const stampLine = (p: number): string => `**Stamp:** Лист ${p + 1} из ${pageCount} · Шифр ФИКС-АР · Стадия П`;
  const hugeText = o.hugeTextChars ? 'я'.repeat(o.hugeTextChars) : null;
  const md: string[] = [`# ${docName}`, ''];
  for (let p = 0; p < pageCount; p += 1) {
    if (omitted.has(p)) continue;
    md.push(`## Page ${p + 1}`, '');
    for (const b of blocks.filter((x) => x.page_index === p && x.block_type !== 'stamp')) {
      const type = b.block_type.toUpperCase();
      md.push(`### BLOCK #${b.ordinal} [${type}]: ${b.block_id}`, '');
      if (b.block_type === 'image') {
        md.push(`**Summary:** Краткое описание ${b.block_id}.`);
        md.push(`**Description:** Подробное описание изображения ${b.block_id} на листе ${p + 1}.`);
        md.push('**Entities:** насос, задвижка, фильтр');
        md.push('**Verification:** соответствует спецификации');
      } else if (hugeText && b.block_id === textBlockIds[0]) {
        md.push(hugeText);
      } else {
        md.push(`Распознанный текст блока ${b.block_id} на листе ${p + 1}.`);
        md.push('Вторая строка распознанного текста.');
      }
      if (stamps === 'per-page') md.push('', stampLine(p));
      md.push('');
    }
  }
  const resultsMd = md.join('\n');
  const resultsHtml = `<!doctype html><html><body><h1>${docName}</h1></body></html>`;

  const omit = new Set(o.omit ?? []);
  const entries: IZipEntry[] = [];
  if (!omit.has('pdf')) entries.push({ name: `${docName}.pdf`, data: pdf });
  if (!omit.has('blocks')) entries.push({ name: `${docName}_blocks.json`, data: Buffer.from(blocksJson, 'utf8') });
  if (!omit.has('md')) entries.push({ name: `${docName}_results.md`, data: Buffer.from(resultsMd, 'utf8') });
  if (!omit.has('html')) entries.push({ name: `${docName}_results.html`, data: Buffer.from(resultsHtml, 'utf8') });
  if (o.unsafeMember === 'traversal') entries.push({ name: '../эвакуация.txt', data: Buffer.from('x') });
  if (o.unsafeMember === 'symlink') entries.push({ name: 'link.pdf', data: Buffer.from('/etc/passwd'), symlink: true });
  if (o.unsafeMember === 'encrypted') entries.push({ name: 'secret.json', data: Buffer.from('{}'), encrypted: true });
  entries.push(...(o.extraMembers ?? []));

  const missingPages = [...omitted].sort((a, b) => a - b);
  return {
    zip: buildZip(entries),
    pdf,
    blocksJson,
    resultsMd,
    expected: {
      pdfSha256: sha256(pdf),
      docName,
      pagesTotal: pageCount,
      pagesRecognized: pageCount - missingPages.length,
      status: missingPages.length === 0 ? 'complete' : 'partial',
      missingPages,
      textBlockIds,
      imageBlockIds,
      stampBlockIds,
      unknownBlockIds,
    },
  };
};
