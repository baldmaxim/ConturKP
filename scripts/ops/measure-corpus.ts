// Синтетический корпус распознанного текста для замера профиля нагрузки D-040 (до 1 ГБ Markdown): документы
// с экспортом RDWeb — настоящий PDF на P страниц и `_results.md` с уникальным текстом каждой страницы. Текст
// детерминирован (зерно — номер документа и страницы) и собран из словаря строительной документации: запросы
// замера находят его, а эмбеддинги не попадают в кеш одинаковых текстов. Данных заказчика нет.
import { buildZip, realPdf } from '../../tests/zip.ts';

export interface IMdDoc {
  index: number;
  name: string;
  pages: number;
}

// Предел страниц одного документа ниже RECOGNITION_MAX_PAGES (10 000) с запасом.
const MAX_PAGES = 9000;

// План: totalMb мегабайт текста кусками по docMb, страница — pageKb килобайт UTF-8.
export const mdCorpusPlan = (o: { totalMb: number; docMb: number; pageKb: number }): IMdDoc[] => {
  const totalPages = Math.max(1, Math.round((o.totalMb * 1024) / o.pageKb));
  const perDoc = Math.min(MAX_PAGES, Math.max(1, Math.round((o.docMb * 1024) / o.pageKb)));
  const docs: IMdDoc[] = [];
  for (let left = totalPages, i = 1; left > 0; left -= perDoc, i += 1) {
    docs.push({ index: i, name: `MD-Том-${String(i).padStart(4, '0')}`, pages: Math.min(perDoc, left) });
  }
  return docs;
};

const WORDS = [
  'бетон', 'класса', 'B25', 'армирование', 'арматура', 'А500С', 'монолитных', 'конструкций', 'перекрытие', 'фундаментная', 'плита',
  'кладка', 'перегородок', 'штукатурка', 'стен', 'гидроизоляция', 'кровли', 'утеплитель', 'фасада', 'вентиляции', 'отопления',
  'водоснабжения', 'канализации', 'электроснабжения', 'освещения', 'слаботочных', 'систем', 'пожарной', 'сигнализации', 'лифтового',
  'оборудования', 'благоустройства', 'территории', 'подрядчик', 'заказчик', 'генеральный', 'договор', 'подряда', 'срок', 'выполнения',
  'работ', 'гарантийный', 'стоимость', 'смета', 'расчёт', 'позиция', 'ведомость', 'объёмов', 'спецификация', 'материалов', 'поставка',
  'приёмка', 'исполнительная', 'документация', 'акт', 'скрытых', 'журнал', 'производства', 'технический', 'надзор', 'проект',
  'рабочая', 'стадия', 'раздел', 'лист', 'чертёж', 'узел', 'деталь', 'отметка', 'оси', 'этаж', 'секция', 'корпус', 'подземной',
  'части', 'надземной', 'автостоянки', 'входной', 'группы', 'лестничной', 'клетки', 'шахты', 'двери', 'окна', 'витражи', 'ограждения',
  'покрытие', 'полов', 'стяжка', 'цементно-песчаная', 'толщиной', 'мм', 'м2', 'м3', 'т', 'шт', 'комплект', 'согласно', 'требованиям',
  'СП', 'ГОСТ', 'пункт', 'таблица', 'приложение', 'условия', 'оплаты', 'аванс', 'неустойка', 'штраф', 'изменение', 'объёма', 'цены',
];

// mulberry32: детерминированная последовательность по зерну.
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Текст страницы ≈ pageKb килобайт UTF-8: предложения из словаря, номера пунктов и размеры.
export const pageText = (doc: number, page: number, pageKb: number): string => {
  const next = rng(doc * 1_000_003 + page);
  const target = pageKb * 1024;
  const out: string[] = [];
  let size = 0;
  let n = 0;
  while (size < target) {
    n += 1;
    const len = 8 + Math.floor(next() * 9);
    const words: string[] = [];
    for (let i = 0; i < len; i += 1) words.push(WORDS[Math.floor(next() * WORDS.length)]!);
    const sentence = `П. ${doc}.${page + 1}.${n}. ${words.join(' ')} ${Math.floor(next() * 900) + 100}×${Math.floor(next() * 90) + 10} мм.`;
    out.push(sentence);
    size += Buffer.byteLength(sentence, 'utf8') + 1;
  }
  return out.join(' ');
};

// Оригинал документа: настоящий PDF на d.pages страниц, различный для каждого документа.
export const mdPdf = (d: IMdDoc): Buffer => realPdf(Array.from({ length: d.pages }, () => ({})), d.name);

// Части экспорта RDWeb документа: PDF, `_blocks.json` (по текстовому блоку на страницу) и `_results.md`.
export const mdExportParts = (d: IMdDoc, pageKb: number): { pdf: Buffer; blocksJson: string; resultsMd: string } => {
  const pages = Array.from({ length: d.pages }, (_, i) => ({ page_index: i, page_label: i + 1, width_px: 2480, height_px: 3508, rotation: 0 }));
  const blocks = pages.map((p) => ({
    block_id: `md-${d.index}-${p.page_index}`,
    ordinal: p.page_index + 1,
    page_index: p.page_index,
    page_label: p.page_label,
    block_type: 'text',
    shape_type: 'rectangle',
    status: 'recognized',
    export_status: 'recognized',
    coords_norm: [0.08, 0.08, 0.92, 0.92],
    crop_url: '',
  }));
  const blocksJson = JSON.stringify({
    schema_version: 1,
    document_id: `measure-${d.index}`,
    document_name: d.name,
    document_path: `\\\\measure\\${d.name}.pdf`,
    generated_at: '2026-10-15T00:00:00Z',
    coordinate_space: 'normalized_page_top_left',
    pages,
    blocks,
  });
  const md: string[] = [`# ${d.name}`, ''];
  for (const b of blocks) md.push(`## Page ${b.page_label}`, '', `### BLOCK #${b.ordinal} [TEXT]: ${b.block_id}`, '', pageText(d.index, b.page_index, pageKb), '');
  return { pdf: mdPdf(d), blocksJson, resultsMd: md.join('\n') };
};

// Архив экспорта RDWeb: части и `_results.html`, текст сжат.
export const mdExport = (d: IMdDoc, pageKb: number): { zip: Buffer; mdBytes: number } => {
  const parts = mdExportParts(d, pageKb);
  const resultsMd = Buffer.from(parts.resultsMd, 'utf8');
  const zip = buildZip([
    { name: `${d.name}.pdf`, data: parts.pdf },
    { name: `${d.name}_blocks.json`, data: Buffer.from(parts.blocksJson, 'utf8'), deflate: true },
    { name: `${d.name}_results.md`, data: resultsMd, deflate: true },
    { name: `${d.name}_results.html`, data: Buffer.from(`<!doctype html><html><body><h1>${d.name}</h1></body></html>`, 'utf8'), deflate: true },
  ]);
  return { zip, mdBytes: resultsMd.length };
};
