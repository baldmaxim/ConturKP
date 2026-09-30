// Фикстуры этапа 05a: синтетические DOCX, XLSX, CSV и небезопасные или повреждённые пакеты. Смета
// Стромынки строится из фикстуры Locus (smeta-stromynka.md — «выход конвертера xlsx», номер строки
// листа в первой колонке): те же листы, номера строк и значения; числа — числовыми ячейками с форматом
// «# ##0», итог — формулой SUM с сохранённым значением. Так воспроизводится структура случаев 10, 14, 15.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocx, buildXlsx, buildZip, type IXCell, type IXSheet } from './ooxmlFixtures.ts';

const LOCUS = join(import.meta.dirname, 'fixtures', 'locus-product-v2', 'stromynka');

const colLetter = (i: number): string => String.fromCharCode(65 + i);

export const smetaStromynkaSheets = (): IXSheet[] => {
  const md = readFileSync(join(LOCUS, 'smeta-stromynka.md'), 'utf8');
  const sheets: IXSheet[] = [];
  let current: IXSheet | null = null;
  for (const line of md.split('\n')) {
    const title = /^## Лист: (.+)$/.exec(line.trim());
    if (title) {
      current = { name: title[1]!, cells: [] };
      sheets.push(current);
      continue;
    }
    if (!current || !line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim());
    const row = Number(cols[0]);
    cols.slice(1).forEach((value, i) => {
      if (value === '') return;
      const ref = `${colLetter(i)}${row}`;
      const numeric = /^\d[\d ]*$/.test(value) && row !== 1;
      if (!numeric) {
        current!.cells.push({ ref, v: value });
      } else if (current!.name === 'Сводная' && value === '244 800 000') {
        // Итог сметы — формула с сохранённым значением: разбор берёт сохранённое, не вычисляет.
        current!.cells.push({ ref, f: `SUM(${colLetter(i)}5:${colLetter(i)}11)`, cached: Number(value.replace(/ /g, '')), style: 'int' });
      } else {
        current!.cells.push({ ref, v: Number(value.replace(/ /g, '')), style: i === 0 ? 'general' : 'int' });
      }
    });
  }
  return sheets;
};

export const smetaStromynkaXlsx = (): Buffer => buildXlsx(smetaStromynkaSheets());

// Края разбора XLSX: объединённые ячейки, скрытый и пустой листы, дата, процент, строка без общей
// таблицы, логическое значение, формула без сохранённого значения.
export const edgeXlsx = (): Buffer => {
  const main: IXCell[] = [
    { ref: 'A1', v: 'Ведомость объёмов работ' },
    { ref: 'A3', v: 'Позиция' },
    { ref: 'B3', v: 'Дата' },
    { ref: 'C3', v: 'Готовность' },
    { ref: 'D3', v: 'Принято' },
    { ref: 'A4', v: 'Фундамент', inline: true },
    { ref: 'B4', v: 46000, style: 'date' },
    { ref: 'C4', v: 0.35, style: 'pct' },
    { ref: 'D4', v: true },
    { ref: 'A5', v: 'Каркас' },
    { ref: 'C5', v: 0.1, style: 'pct' },
  ];
  return buildXlsx([
    { name: 'Ведомость', cells: main, merges: ['A1:D1'] },
    { name: 'Пусто', cells: [] },
    { name: 'Служебный', state: 'hidden', cells: [{ ref: 'A1', v: 'Скрытая строка' }] },
  ]);
};

export const formulaWithoutValueXlsx = (): Buffer =>
  buildXlsx([{ name: 'Расчёт', cells: [{ ref: 'A1', v: 'Сумма' }, { ref: 'B1', f: 'SUM(B2:B3)' }, { ref: 'B2', v: 10, style: 'int' }] }]);

export const contractDocx = (): Buffer =>
  buildDocx({
    header: 'ООО «СтройМонолит» — колонтитул',
    blocks: [
      { p: 'ДОГОВОР СТРОИТЕЛЬНОГО ПОДРЯДА № 15-П' },
      { p: 'г. Москва, 10 февраля 2026 г.' },
      { p: '1. Генподрядчик обязуется выполнить работы по устройству монолитного каркаса.', footnote: 1 },
      { p: '2. Цена договора составляет 245 000 000 рублей.', sectionBreak: true, link: 'http://127.0.0.1:9/never-fetched' },
      { table: [['Этап', 'Срок', 'Сумма, руб.'], ['Котлован', '01.04.2026', '21 600 000'], ['', '', ''], ['Каркас', '01.09.2026', '98 500 000']] },
      { p: '3. Аванс — 10 % цены договора.' },
    ],
    footnotes: [{ id: 1, text: 'Проектная документация шифр 15-П-КЖ.' }],
  });

// Windows-1251: только символы, которые встречаются в фикстурах.
const CP1251: Record<string, number> = { '№': 0xb9, Ё: 0xa8, ё: 0xb8 };
export const toCp1251 = (s: string): Buffer =>
  Buffer.from(
    [...s].map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      const mapped = CP1251[ch];
      if (mapped === undefined) throw new Error(`символ ${ch} не в таблице cp1251 фикстуры`);
      return mapped;
    }),
  );

export const SMETA_CSV = 'Позиция;Ед. изм.;Объём;Стоимость, руб.\r\nЗемляные работы;м3;18 400;21 600 000\r\n;;;\r\nМонолитный каркас;м3;9 850;98 500 000\r\n';

export const csvUtf8Bom = (): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SMETA_CSV, 'utf8')]);
export const csvCp1251 = (): Buffer => toCp1251(SMETA_CSV);
export const csvQuoted = (): Buffer =>
  Buffer.from('Поставщик,Условие,Цена\n"ООО ""Бетон-Сервис""","Доставка\nв пределах МКАД",7450\nАрматура,"",68900\n', 'utf8');
export const csvBrokenQuote = (): Buffer => Buffer.from('Поставщик;Цена\n"ООО Кирпич;21300\n', 'utf8');

// ---------------------------------------------------------------- Повреждённые и небезопасные пакеты

export const truncatedDocx = (): Buffer => contractDocx().subarray(0, 300);

export const xxeDocx = (): Buffer =>
  buildDocx({
    blocks: [],
    documentXml:
      '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>',
  });

export const traversalXlsx = (): Buffer =>
  buildZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '../../evil.xml', data: '<x/>' },
  ]);

// Часть, сжатая сильнее допустимого отношения (защита от zip-бомбы).
export const bombXlsx = (): Buffer => {
  const huge = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${' '.repeat(8 * 1024 * 1024)}</sheetData></worksheet>`;
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: '_rels/.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Бомба" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: huge },
  ]);
};

// Уникальная копия файла: импорт склеивает одинаковое содержимое тендера в одну редакцию (этап 03),
// а тестам нужны отдельные редакции. Смысл файла не меняется: у ZIP — комментарий архива, у PDF —
// комментарий после конца файла, у текста — пустые строки в конце.
let copies = 0;
export const uniqueCopy = (b: Buffer, kind: 'zip' | 'pdf' | 'text'): Buffer => {
  copies += 1;
  if (kind === 'pdf') return Buffer.concat([b, Buffer.from(`\n%copy-${copies}\n`)]);
  if (kind === 'text') return Buffer.concat([b, Buffer.from('\r\n'.repeat(copies))]);
  const comment = Buffer.from(`copy-${copies}`);
  const out = Buffer.concat([b, comment]);
  out.writeUInt16LE(comment.length, b.length - 2);
  return out;
};
