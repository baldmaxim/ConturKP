// Этап 12 — ядро и адаптер файлов выпуска без БД (D-032; ADR-013): разметка образца и её проверка по схеме (обязательные
// поля, таблицы, условные блоки), вывод значений, генерация DOCX/XLSX по размеченной копии, конвертация LibreOffice,
// разбор PDF (текст, кириллица, шрифты), подмена шрифтов, детерминированность, сверка чисел с расчётом, манифест.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  checkMarkup,
  compareWithCalculation,
  documentMarks,
  formatNumber,
  manifestSha256,
  normalizeFontName,
  renderData,
  substitutedFonts,
  tagsOfText,
  TEST_MARK,
  DEMO_MARK,
  type FieldValue,
  type IFormSchema,
  type IManifest,
} from '../packages/core/src/index.ts';
import {
  detectFormat,
  docxUsedFonts,
  inspectPdf,
  leftoverTags,
  renderDocx,
  renderXlsx,
  scanDocxTags,
  scanXlsxTags,
  xlsxUsedFonts,
  type IOfficeConverter,
} from '../packages/adapters/src/index.ts';
import { demoSchema } from './formsFixtures.ts';
import { requireConverter } from './releaseFixtures.ts';

// Сборки и конвертации LibreOffice на Windows под нагрузкой дольше 30 с (Review 12-1: тест двух сборок превысил предел,
// следующий получил `candidate_assembling`): предел теста — с запасом, ожидания не меняются.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const letterMarked = readFileSync('docs/forms/samples/demo-kp-letter.marked.docx');
const letterOriginal = readFileSync('docs/forms/samples/demo-kp-letter.original.docx');
const conditionsMarked = readFileSync('docs/forms/samples/demo-key-conditions.marked.xlsx');
const LETTER = demoSchema('demo-kp-letter');
const CONDITIONS = demoSchema('demo-key-conditions');
const LONG = 'Подрядчик выполняет работы в соответствии с проектной и рабочей документацией, техническим заданием и требованиями заказчика. '.repeat(160);

const letterValues = (over: Record<string, FieldValue | null> = {}): Map<string, FieldValue | null> =>
  new Map<string, FieldValue | null>(
    Object.entries({
      letter_date: '2026-10-06',
      letter_number: '04/26-01-ТО',
      addressee: 'Тендерному управлению ООО «Заказчик-Демо»',
      subject: 'Строительство демонстрационного объекта',
      materials_price_date: '2026-09-01',
      kp_price: '1234.56',
      advance_percent: '30',
      retention_percent: null,
      duration_months: '32',
      warranty_months: '60',
      inflation_threshold: '5',
      validity_days: '30',
      conditions_text: LONG,
      missing_data: [{ item: 'Геологические изыскания' }, { item: 'Технические условия на подключение' }],
      ...over,
    }),
  );

let converter: IOfficeConverter;
beforeAll(async () => {
  converter = requireConverter();
});

describe('разметка образца (D-032 В-12-3)', () => {
  it('теги абзаца, блоки, непарные скобки', () => {
    expect(tagsOfText('А {{a}} {{#b}}x{{/b}} {{ c }}', 'p1').map((t) => [t.kind, t.key])).toEqual([
      ['value', 'a'],
      ['open', 'b'],
      ['close', 'b'],
      ['value', 'c'],
    ]);
    expect(tagsOfText('{{Я}} {{a', 'p1').map((t) => t.kind)).toEqual(['invalid', 'invalid']);
  });

  it('размеченная копия письма проходит проверку; оригинал образца — нет (нет плейсхолдеров)', () => {
    const ok = checkMarkup(LETTER, 'docx', scanDocxTags(letterMarked));
    expect(ok.issues).toEqual([]);
    expect(ok.loops).toEqual([{ key: 'missing_data', columns: ['item'] }]);
    expect(ok.blocks).toEqual(['conditions_text', 'inflation_threshold', 'kp_price', 'missing_data', 'retention_percent', 'warranty_months']);
    expect(checkMarkup(LETTER, 'docx', scanDocxTags(letterOriginal)).issues.map((i) => i.code)).toContain('no_placeholders');
    expect(checkMarkup(CONDITIONS, 'xlsx', scanXlsxTags(conditionsMarked)).issues).toEqual([]);
  });

  it('ошибки: неизвестный ключ, незакрытый блок, обязательное поле не выводится, таблица без повторения, колонка, блок в XLSX', () => {
    const codes = (format: 'docx' | 'xlsx', text: string, schema: IFormSchema = LETTER) => checkMarkup(schema, format, tagsOfText(text, 'p')).issues.map((i) => i.code);
    expect(codes('docx', '{{nope}}')).toContain('unknown_key');
    expect(codes('docx', '{{#kp_price}} {{kp_price}}')).toContain('block_not_closed');
    expect(codes('docx', '{{/kp_price}}')).toContain('close_without_open');
    expect(codes('docx', '{{letter_number}}')).toContain('required_not_printed');
    expect(codes('docx', '{{missing_data}}')).toContain('table_requires_loop');
    expect(codes('docx', '{{#missing_data}}{{nope}}{{/missing_data}}')).toContain('unknown_column');
    expect(codes('xlsx', '{{#kp_price}}{{/kp_price}}')).toContain('xlsx_block_unsupported');
    const requiredColumn = checkMarkup(LETTER, 'docx', tagsOfText('{{#missing_data}}—{{/missing_data}}', 'p')).issues.map((i) => i.code);
    expect(requiredColumn).toContain('required_column_not_printed');
  });
});

describe('вывод значений', () => {
  it('число — группы разрядов неразрывным пробелом, запятая; дата — ДД.ММ.ГГГГ; вариант — подпись; неприменимое — false', () => {
    expect(formatNumber('25000000')).toBe('25 000 000');
    expect(formatNumber('1234.5')).toBe('1 234,5');
    const d = renderData(CONDITIONS, new Map<string, FieldValue | null>([['price_kind', 'firm'], ['compensation_mechanism', 'basket'], ['inflation_threshold', '5']]), 'xlsx');
    expect(d.price_kind).toBe('Твёрдая договорная цена');
    expect(d.inflation_threshold).toBe(false);
    expect(renderData(LETTER, letterValues(), 'docx').letter_date).toBe('06.10.2026');
    // Денежное поле — до scale знаков нулями (просмотр страниц человеком, D-032 В-12-10); процент без валюты — как есть.
    expect(formatNumber('120', 2)).toBe('120,00');
    expect(renderData(LETTER, letterValues({ kp_price: '120' }), 'docx').kp_price).toBe('120,00');
    expect(renderData(LETTER, letterValues({ kp_price: '1234.5' }), 'docx').kp_price).toBe('1\u00a0234,50');
    expect(renderData(LETTER, letterValues(), 'docx').advance_percent).toBe('30');
  });
});

describe('генерация и превью (ADR-013; D-032 В-12-2, В-12-8, В-12-10)', () => {
  it('A41: DOCX — значения на месте, плейсхолдеров нет, отметки видны в документе и PDF, кириллица и длинный текст целиком, шрифт встроен', async () => {
    const data = renderData(LETTER, letterValues(), 'docx');
    const marks = documentMarks('test', true);
    const docx = renderDocx(letterMarked, data, marks);
    expect(detectFormat(docx)).toBe('docx');
    expect(leftoverTags(docx, 'docx')).toEqual([]);
    expect(renderDocx(letterMarked, data, marks).equals(docx)).toBe(true);
    const pdf = await converter.toPdf(docx, 'docx');
    const info = await inspectPdf(pdf);
    const text = info.pageTexts.join('\n').replace(/\s+/gu, ' ');
    expect(info.pages).toBeGreaterThan(1);
    for (const m of [TEST_MARK, DEMO_MARK, '04/26-01-ТО', '06.10.2026', '1 234,56', 'Геологические изыскания', 'Технические условия на подключение']) expect(text).toContain(m.replace(/\s+/gu, ' '));
    expect(text).toContain(LONG.trim().replace(/\s+/gu, ' ').slice(-200));
    expect(text).not.toContain('{{');
    expect(text).not.toContain('Гарантийное удержание');
    expect(info.producer).toMatch(/LibreOffice/u);
    expect(docxUsedFonts(docx)).toEqual(['Liberation Serif']);
    expect(substitutedFonts(docxUsedFonts(docx), info.fonts.filter((f) => f.embedded).map((f) => f.name))).toEqual([]);
  });

  it('XLSX: подстановка в текст ячейки и числом, отметки в ячейке и колонтитуле, шрифт встроен', async () => {
    const values = new Map<string, FieldValue | null>(
      Object.entries({
        price_kind: 'firm',
        estimate_units: 'Сметы составляются по этажам и секциям.',
        site_upkeep_month: '25.5',
        duration_months: '32',
        advance_percent: '30',
        advance_security: 'none',
        compensation_mechanism: 'inflation',
        inflation_threshold: '5',
        methodology_variant: 'inflation_only',
        warranty_months: '36',
        not_included: [{ item: 'Наружные сети', note: 'по отдельному договору' }],
      }),
    );
    const data = renderData(CONDITIONS, values, 'xlsx');
    const xlsx = renderXlsx(conditionsMarked, data, new Set(['site_upkeep_month']), documentMarks('test', false));
    expect(detectFormat(xlsx)).toBe('xlsx');
    expect(leftoverTags(xlsx, 'xlsx')).toEqual([]);
    const PizZip = (await import('pizzip')).default;
    expect(new PizZip(xlsx).file('xl/worksheets/sheet1.xml')!.asText()).toMatch(/<c r="C5" s="3"><v>25\.5<\/v><\/c>/u);
    const info = await inspectPdf(await converter.toPdf(xlsx, 'xlsx'));
    const text = info.pageTexts.join('\n').replace(/\s+/gu, ' ');
    for (const m of [TEST_MARK, 'Твёрдая договорная цена', '30 % от цены договора', '1) Наружные сети — по отдельному договору', '25,50']) expect(text).toContain(m);
    expect(xlsxUsedFonts(xlsx)).toEqual(['Liberation Sans']);
    expect(substitutedFonts(xlsxUsedFonts(xlsx), info.fonts.filter((f) => f.embedded).map((f) => f.name))).toEqual([]);
  });

  it('подмена шрифта видна: шрифт, которого нет в системе, не встроен в PDF под своим именем', async () => {
    const zipText = letterMarked.toString('latin1');
    expect(zipText.length).toBeGreaterThan(0);
    const PizZip = (await import('pizzip')).default;
    const z = new PizZip(letterMarked);
    z.file('word/styles.xml', z.file('word/styles.xml')!.asText().replace(/Liberation Serif/gu, 'Kontur Nonexistent Serif'));
    const sample = z.generate({ type: 'nodebuffer' });
    const docx = renderDocx(sample, renderData(LETTER, letterValues({ conditions_text: null }), 'docx'));
    const info = await inspectPdf(await converter.toPdf(docx, 'docx'));
    expect(docxUsedFonts(docx)).toEqual(['Kontur Nonexistent Serif']);
    expect(substitutedFonts(docxUsedFonts(docx), info.fonts.filter((f) => f.embedded).map((f) => f.name))).toEqual(['Kontur Nonexistent Serif']);
  });

  // Найдено просмотром страниц человеком (D-032 В-12-10): скрытый блок оставлял пустой абзац (пустые строки, номер
  // автоматического списка без текста), а ручной номер в копии давал «1., 3.».
  it('скрытый блок на весь абзац удаляет абзац: пустых строк нет, автонумерация условий без пропуска', async () => {
    const PizZip = (await import('pizzip')).default;
    const values = letterValues({ kp_price: null, retention_percent: null, conditions_text: 'Кратко.' });
    const docx = renderDocx(letterMarked, renderData(LETTER, values, 'docx'));
    const xml = new PizZip(docx).file('word/document.xml')!.asText();
    const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)].map((p) => p[0]);
    expect(paragraphs.filter((p) => !/<w:t[ >]/u.test(p))).toEqual([]);
    expect(xml).not.toContain('Гарантийное удержание');
    const shown = renderDocx(letterMarked, renderData(LETTER, letterValues(), 'docx'));
    expect([...new PizZip(shown).file('word/document.xml')!.asText().matchAll(/<w:p[ >]/gu)].length).toBe(paragraphs.length + 1);
    const text = (await inspectPdf(await converter.toPdf(docx, 'docx'))).pageTexts.join('\n').replace(/\s+/gu, ' ');
    expect(text).toContain('1. Общий аванс');
    expect(text).toContain('2. Срок выполнения работ');
    expect(text).toContain('3. Гарантийный срок');
    expect(text).toContain('4. Компенсация роста');
  });

  // S12-04: LibreOffice загружал внешнюю картинку по ссылке из документа (запрос с машины worker по адресу из файла).
  it('конвертация не обращается к сети: картинка по внешней ссылке, поле INCLUDEPICTURE, формула WEBSERVICE — запросов нет', async () => {
    const { createServer } = await import('node:http');
    const PizZip = (await import('pizzip')).default;
    const hits: string[] = [];
    const srv = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('42');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const d = new PizZip(letterOriginal);
      d.file('word/_rels/document.xml.rels', d.file('word/_rels/document.xml.rels')!.asText().replace('</Relationships>', `<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${base}/image.png" TargetMode="External"/></Relationships>`));
      const pic = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="p"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:link="rIdX"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
      const field = `<w:p><w:fldSimple w:instr=' INCLUDEPICTURE "${base}/field.png" \\d '><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`;
      d.file('word/document.xml', d.file('word/document.xml')!.asText().replace('<w:body>', `<w:body>${pic}${field}`));
      await converter.toPdf(d.generate({ type: 'nodebuffer' }), 'docx');
      const x = new PizZip(readFileSync('docs/forms/samples/demo-key-conditions.original.xlsx'));
      x.file('xl/worksheets/sheet1.xml', x.file('xl/worksheets/sheet1.xml')!.asText().replace('<c r="D3" s="2"/>', `<c r="D3" s="2" t="str"><f>WEBSERVICE("${base}/ws")</f><v>0</v></c>`));
      await converter.toPdf(x.generate({ type: 'nodebuffer' }), 'xlsx');
    } finally {
      srv.close();
    }
    expect(hits).toEqual([]);
  });

  it('значение с фигурными скобками — данные: печатается как есть, разметкой не становится', () => {
    const docx = renderDocx(letterMarked, renderData(LETTER, letterValues({ conditions_text: 'Текст {{letter_number}} {{#x}}' }), 'docx'));
    expect(leftoverTags(docx, 'docx').length).toBeGreaterThan(0);
    const probe = renderDocx(letterMarked, renderData(LETTER, letterValues({ conditions_text: 'нейтрально' }), 'docx'));
    expect(leftoverTags(probe, 'docx')).toEqual([]);
  });
});

describe('сверка с расчётом и манифест (D-032 В-12-6)', () => {
  const field = { unit: 'млн руб.', currency: 'RUB', scale: 2 };
  it('точный перевод в единицы поля с округлением до scale; другая валюта и неизвестное — «не сверено»', () => {
    expect(compareWithCalculation(field, '25.12', 'source_grand_total', '25123456.78')).toEqual({ outcome: 'match', expected: '25.12' });
    expect(compareWithCalculation(field, '25.13', 'source_grand_total', '25123456.78')).toEqual({ outcome: 'mismatch', expected: '25.12' });
    expect(compareWithCalculation({ unit: 'руб.', currency: 'RUB' }, '25123456.78', 'source_grand_total', '25123456.78').outcome).toBe('match');
    expect(compareWithCalculation({ unit: 'USD', currency: 'USD' }, '100', 'source_grand_total', '100').outcome).toBe('unverified');
    expect(compareWithCalculation(field, '25.12', 'source_grand_total', null).outcome).toBe('unverified');
  });

  it('канонический манифест стабилен; нормализация имён шрифтов', () => {
    const m = { schema: 'kontur-manifest/1', candidate: { id: 'c', seq: 1, mode: 'test', tenderId: 't', stageId: 's', createdAt: 'x', marks: [] }, files: [], checks: [], notes: [] } as unknown as IManifest;
    expect(manifestSha256(m)).toBe(manifestSha256(JSON.parse(JSON.stringify(m)) as IManifest));
    expect(normalizeFontName('BAAAAA+TimesNewRomanPS-BoldMT')).toBe('timesnewroman');
    expect(normalizeFontName('Times New Roman')).toBe('timesnewroman');
    expect(normalizeFontName('CAAAAA+LiberationSans-Bold')).toBe('liberationsans');
  });
});

