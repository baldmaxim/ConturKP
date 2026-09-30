// Разбор локальных форматов без БД (этап 05a, D-024): якоря DOCX, XLSX, CSV воспроизводимы (тесты 8–10
// решения владельца), фикстура XLSX детерминирована и воспроизводит структуру случаев 10, 14, 15 Locus,
// повреждённый и небезопасный пакет — явный отказ (тест 16, A38), CSV в другой кодировке (тест 17),
// пределы «очень большого файла» (тест 18), неподдерживаемая структура — отказ, а не догадка (OD-4).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_LIMITS, formatNumber, LocalRecognitionError, parseCsv, parseDocx, parseXlsx, type ILocalResult } from '../packages/adapters/src/index.ts';
import * as fx from './localFixtures.ts';
import { buildDocx, buildXlsx } from './ooxmlFixtures.ts';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const anchors = (r: ILocalResult) => r.fragments.map((f) => ({ key: f.key, locator: f.locator, text: f.text }));
const failure = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof LocalRecognitionError ? e.code : String(e)));

describe('XLSX', () => {
  it('фикстура сметы детерминирована: два построения — байт в байт', () => {
    expect(sha(fx.smetaStromynkaXlsx())).toBe(sha(fx.smetaStromynkaXlsx()));
  });

  it('структура случаев 10, 14, 15 Locus: лист, строка, диапазон и значение воспроизводятся', async () => {
    const r = await parseXlsx(fx.smetaStromynkaXlsx(), DEFAULT_LOCAL_LIMITS);
    expect(r.units.map((u) => [u.kind, u.label, u.status])).toEqual([
      ['xlsx_sheet', 'Сводная', 'recognized'],
      ['xlsx_sheet', 'Материалы', 'recognized'],
    ]);
    const at = (sheet: string, row: number) => r.fragments.find((f) => f.locator.kind === 'xlsx_cells' && f.locator.sheet === sheet && f.locator.rowFrom === row)!;
    expect(at('Сводная', 7).text).toContain('98 500 000');
    expect(at('Сводная', 7).locator).toMatchObject({ range: 'A7:E7', sheetIndex: 1, colFrom: 1, colTo: 5 });
    // Итог — формула SUM с сохранённым значением: берётся сохранённое, не вычисляется.
    expect(at('Сводная', 12).text).toBe('8 | Итого по смете | 244 800 000');
    expect(at('Материалы', 4).text).toContain('7 450');
    expect(at('Материалы', 4).locator).toMatchObject({ sheet: 'Материалы', sheetIndex: 2, range: 'A4:E4' });
    expect(r.fragments.every((f) => f.origin === 'document_text')).toBe(true);
  });

  it('якоря воспроизводимы: повторный разбор того же файла даёт те же ключи, якоря и текст', async () => {
    const a = await parseXlsx(fx.smetaStromynkaXlsx(), DEFAULT_LOCAL_LIMITS);
    const b = await parseXlsx(fx.smetaStromynkaXlsx(), DEFAULT_LOCAL_LIMITS);
    expect(anchors(a)).toEqual(anchors(b));
  });

  it('края: объединённые ячейки, пустой и скрытый лист, дата, процент, логическое значение', async () => {
    const r = await parseXlsx(fx.edgeXlsx(), DEFAULT_LOCAL_LIMITS);
    expect(r.units.map((u) => u.label)).toEqual(['Ведомость', 'Служебный']);
    expect(r.skipped.emptySheets).toBe(1);
    expect(r.facts.hiddenSheets).toBe(1);
    const title = r.fragments.find((f) => f.key === 's1:r1')!;
    expect(title.locator).toMatchObject({ merged: ['A1:D1'] });
    expect(r.fragments.find((f) => f.key === 's1:r4')!.text).toBe('Фундамент | 2025-12-09 | 35% | TRUE');
  });

  it('формула без сохранённого значения — лист требует проверки (OD-6)', async () => {
    const r = await parseXlsx(fx.formulaWithoutValueXlsx(), DEFAULT_LOCAL_LIMITS);
    expect(r.units[0]).toMatchObject({ status: 'needs_review', issues: ['formula_without_value'] });
  });

  it('форматы чисел: группы разрядов, дробь, процент, литерал единицы', () => {
    expect(formatNumber('98500000', '#,##0', false)).toBe('98 500 000');
    expect(formatNumber('68900.5', '#,##0.00', false)).toBe('68 900,50');
    expect(formatNumber('0.35', '0%', false)).toBe('35%');
    expect(formatNumber('7450', '#,##0 "руб."', false)).toBe('7 450 руб.');
    expect(formatNumber('12.5', null, false)).toBe('12,5');
  });

  it('предел ячеек — явный отказ too_large (тест 18)', async () => {
    expect(await failure(parseXlsx(fx.smetaStromynkaXlsx(), { ...DEFAULT_LOCAL_LIMITS, maxCells: 10 }))).toBe('too_large');
    expect(await failure(parseXlsx(fx.smetaStromynkaXlsx(), { ...DEFAULT_LOCAL_LIMITS, maxInputBytes: 100 }))).toBe('too_large');
  });

  it('повреждённый, небезопасный, zip-бомба — явный отказ (тест 16, A38)', async () => {
    expect(await failure(parseXlsx(fx.smetaStromynkaXlsx().subarray(0, 200), DEFAULT_LOCAL_LIMITS))).toBe('file_corrupt');
    expect(await failure(parseXlsx(fx.traversalXlsx(), DEFAULT_LOCAL_LIMITS))).toBe('unsafe_package');
    expect(await failure(parseXlsx(fx.bombXlsx(), DEFAULT_LOCAL_LIMITS))).toBe('unsafe_package');
  });

  it('пакет не книги Excel — unsupported_structure, а не угадывание разборщика', async () => {
    expect(await failure(parseXlsx(fx.contractDocx(), DEFAULT_LOCAL_LIMITS))).toBe('unsupported_structure');
  });
});

describe('DOCX', () => {
  it('блоки тела, разделы, таблица, сноска; колонтитул и внешняя ссылка не читаются', async () => {
    const r = await parseDocx(fx.contractDocx(), DEFAULT_LOCAL_LIMITS);
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ kind: 'docx_body', status: 'recognized', widthPx: null, heightPx: null });
    expect(r.fragments.map((f) => f.key)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5:t1:r1', 'b5:t1:r2', 'b5:t1:r4', 'b6', 'fn1']);
    expect(r.fragments.find((f) => f.key === 'b5:t1:r2')!.locator).toEqual({
      kind: 'docx_table_row',
      part: 'body',
      block: 5,
      section: 2,
      table: 1,
      row: 2,
      cellFrom: 1,
      cellTo: 3,
    });
    expect(r.fragments.find((f) => f.key === 'b4')!.locator).toEqual({ kind: 'docx_paragraph', part: 'body', block: 4, section: 1 });
    expect(r.fragments.find((f) => f.key === 'fn1')!.locator).toMatchObject({ part: 'footnotes' });
    expect(r.skipped).toMatchObject({ headersFooters: 1, externalLinks: 1 });
    expect(r.fragments.some((f) => f.text.includes('колонтитул'))).toBe(false);
  });

  it('якоря воспроизводимы', async () => {
    expect(anchors(await parseDocx(fx.contractDocx(), DEFAULT_LOCAL_LIMITS))).toEqual(anchors(await parseDocx(fx.contractDocx(), DEFAULT_LOCAL_LIMITS)));
  });

  it('удалённый текст правки и коды полей не выводятся; надпись — отдельным блоком', async () => {
    const r = await parseDocx(
      buildDocx({
        blocks: [
          {
            raw:
              '<w:p><w:r><w:t>Срок </w:t></w:r><w:del><w:r><w:delText>30</w:delText></w:r></w:del><w:ins><w:r><w:t>45</w:t></w:r></w:ins>' +
              '<w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t> дней</w:t></w:r></w:p>',
          },
        ],
      }),
      DEFAULT_LOCAL_LIMITS,
    );
    expect(r.fragments.map((f) => f.text)).toEqual(['Срок 45 дней']);
  });

  it('внедрённый фрагмент altChunk — документ прочитан частично, требует проверки', async () => {
    const r = await parseDocx(buildDocx({ blocks: [{ p: 'Текст договора' }, { raw: '<w:altChunk r:id="rIdX"/>' }] }), DEFAULT_LOCAL_LIMITS);
    expect(r.units[0]).toMatchObject({ status: 'needs_review', issues: ['docx_alt_chunk'] });
  });

  it('XXE, обрезанный пакет — явный отказ (A38)', async () => {
    expect(await failure(parseDocx(fx.xxeDocx(), DEFAULT_LOCAL_LIMITS))).toBe('unsafe_package');
    expect(await failure(parseDocx(fx.truncatedDocx(), DEFAULT_LOCAL_LIMITS))).toBe('file_corrupt');
    expect(await failure(parseDocx(buildXlsx(fx.smetaStromynkaSheets()), DEFAULT_LOCAL_LIMITS))).toBe('unsupported_structure');
  });

  it('пустой документ — единица missing, пригодного текста нет', async () => {
    const r = await parseDocx(buildDocx({ blocks: [{ p: '' }] }), DEFAULT_LOCAL_LIMITS);
    expect(r.fragments).toHaveLength(0);
    expect(r.units[0]!.status).toBe('missing');
  });
});

describe('CSV', () => {
  it('UTF-8 с BOM и Windows-1251 дают один и тот же текст и якоря (тест 17)', async () => {
    const a = await parseCsv(fx.csvUtf8Bom(), DEFAULT_LOCAL_LIMITS);
    const b = await parseCsv(fx.csvCp1251(), DEFAULT_LOCAL_LIMITS);
    expect(a.facts).toMatchObject({ encoding: 'utf-8-bom', delimiter: ';' });
    expect(b.facts).toMatchObject({ encoding: 'windows-1251', delimiter: ';' });
    expect(anchors(a)).toEqual(anchors(b));
    expect(a.fragments.map((f) => f.key)).toEqual(['r1', 'r2', 'r4']);
    expect(a.fragments[1]!.locator).toEqual({ kind: 'csv_rows', rowFrom: 2, rowTo: 2, colFrom: 1, colTo: 4, headerRow: 1, lineFrom: 2, lineTo: 2 });
  });

  it('якоря записей и столбцов воспроизводимы (тест 10)', async () => {
    for (const bytes of [fx.csvUtf8Bom(), fx.csvCp1251(), fx.csvQuoted()]) {
      expect(anchors(await parseCsv(bytes, DEFAULT_LOCAL_LIMITS))).toEqual(anchors(await parseCsv(bytes, DEFAULT_LOCAL_LIMITS)));
    }
  });

  it('кавычки, удвоенные кавычки, перевод строки внутри поля; физические строки в якоре', async () => {
    const r = await parseCsv(fx.csvQuoted(), DEFAULT_LOCAL_LIMITS);
    expect(r.facts).toMatchObject({ delimiter: ',' });
    const row = r.fragments.find((f) => f.key === 'r2')!;
    expect(row.text).toBe('ООО "Бетон-Сервис" | Доставка в пределах МКАД | 7450');
    expect(row.locator).toMatchObject({ lineFrom: 2, lineTo: 3 });
  });

  it('незакрытая кавычка — нарушена структура таблицы, требует проверки', async () => {
    expect((await parseCsv(fx.csvBrokenQuote(), DEFAULT_LOCAL_LIMITS)).units[0]).toMatchObject({ status: 'needs_review', issues: ['unterminated_quote'] });
  });

  it('не UTF-8 и не Windows-1251 — encoding_unsupported, без подмены символов', async () => {
    // 0x98 в Windows-1251 не определён, а последовательность не является UTF-8.
    expect(await failure(parseCsv(Buffer.from([0xc0, 0x98, 0x3b, 0x31, 0x0a]), DEFAULT_LOCAL_LIMITS))).toBe('encoding_unsupported');
  });

  it('пределы размера и ячеек (тест 18)', async () => {
    expect(await failure(parseCsv(fx.csvUtf8Bom(), { ...DEFAULT_LOCAL_LIMITS, maxInputBytes: 10 }))).toBe('too_large');
    expect(await failure(parseCsv(fx.csvUtf8Bom(), { ...DEFAULT_LOCAL_LIMITS, maxCells: 5 }))).toBe('too_large');
  });
});
