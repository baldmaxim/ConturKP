// Демонстрационные образцы шаблонов (этап 12; D-032 В-12-3; ADR-013): вымышленный текст в структуре реальных форм
// компании (проект этапа 11 §1a, этапа 12 §1a). Для каждой формы — исходный образец (переменные места выделены, как в
// реальных формах) и размеченная копия с плейсхолдерами {{ключ}}; оригинал сохраняется. Шрифты — Liberation (LibreOffice
// поставляет их и под Windows), чтобы проверка подмены шрифтов проходила на машинах разработки и ревью.
// Запуск: node scripts/build-demo-samples.mjs → docs/forms/samples/*.docx|xlsx (запись детерминированна).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'forms', 'samples');
mkdirSync(out, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const write = (name, files) => {
  const zip = new PizZip();
  const date = new Date(1980, 0, 1, 0, 0, 0);
  for (const [n, c] of files) zip.file(n, c, { date });
  writeFileSync(join(out, name), zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(`${name}`);
};

// ---------------------------------------------------------------- DOCX: письмо коммерческого предложения

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docxTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:cs="Liberation Serif" w:eastAsia="Liberation Serif"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr></w:style></w:styles>`;
const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Демонстрационная форма с вымышленным текстом — структура письма коммерческого предложения</w:t></w:r></w:p></w:ftr>`;

// Автоматический список «1.» без отступа: в размеченной копии условия нумеруются списком, чтобы скрытое условие не
// оставляло пропуск номера (в оригинале номера набраны вручную, как в реальной форме).
const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:suff w:val="space"/><w:pPr><w:ind w:left="0" w:firstLine="0"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

// Фрагмент: { t: 'текст' } — постоянный; { v: 'ключ', s: 'пример' } — переменный (в оригинале — выделен, в копии — тег).
const run = (part, marked) => {
  if (part.t !== undefined) return `<w:r><w:t xml:space="preserve">${esc(part.t)}</w:t></w:r>`;
  if (marked) return `<w:r><w:t xml:space="preserve">${esc(part.v)}</w:t></w:r>`;
  return `<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">${esc(part.s)}</w:t></w:r>`;
};
const para = (parts, marked, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${parts.map((p) => run(p, marked)).join('')}</w:p>`;
// Пункт условий: в оригинале — «N. » текстом, в копии — абзац автоматического списка.
const item = (n, parts, marked) =>
  marked ? `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${parts.map((p) => run(p, marked)).join('')}</w:p>` : para([{ t: `${n}. ` }, ...parts], marked);
const cell = (parts, marked, width) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(parts, marked)}</w:tc>`;

const letter = (marked) => {
  const T = (t) => ({ t });
  const V = (v, s) => ({ v, s });
  const body = [
    para([T('ООО «Демо-Подрядчик», 000000, г. Примерный, ул. Вымышленная, д. 1')], marked),
    para([T('Исх. № '), V('{{letter_number}}', '[номер]'), T(' от '), V('{{letter_date}}', '[дата]')], marked),
    para([V('{{addressee}}', '[адресат]')], marked),
    para([T('Коммерческое предложение по тендеру «'), V('{{subject}}', '[предмет тендера]'), T('»')], marked, 'Title'),
    para([T('Стоимость материалов и оборудования учтена по состоянию на '), V('{{materials_price_date}}', '[дата цен]'), T('.')], marked),
    para([V('{{#kp_price}}', ''), T('Цена предложения — '), V('{{kp_price}}', '[цена]'), T(' млн руб. с НДС.'), V('{{/kp_price}}', '')], marked),
    para([T('Условия предложения:')], marked),
    item(1, [T('Общий аванс — '), V('{{advance_percent}}', '[аванс]'), T(' % от цены договора.')], marked),
    item(2, [V('{{#retention_percent}}', ''), T('Гарантийное удержание — '), V('{{retention_percent}}', '[удержание]'), T(' % от стоимости выполненных работ.'), V('{{/retention_percent}}', '')], marked),
    item(3, [T('Срок выполнения работ до получения заключения о соответствии — '), V('{{duration_months}}', '[срок]'), T(' мес.')], marked),
    item(4, [V('{{#warranty_months}}', ''), T('Гарантийный срок на общестроительные работы — '), V('{{warranty_months}}', '[гарантия]'), T(' мес.'), V('{{/warranty_months}}', '')], marked),
    item(5, [V('{{#inflation_threshold}}', ''), T('Компенсация роста стоимости материалов — при накопленной инфляции свыше '), V('{{inflation_threshold}}', '[порог]'), T(' %.'), V('{{/inflation_threshold}}', '')], marked),
    para([V('{{#conditions_text}}', ''), T('Прочие условия: '), V('{{conditions_text}}', '[прочие условия]'), V('{{/conditions_text}}', '')], marked),
    para([T('Не предоставленные исходные данные:')], marked),
    `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="600"/><w:gridCol w:w="8400"/></w:tblGrid>` +
      `<w:tr>${cell([T('№')], marked, 600)}${cell([T('Исходные данные')], marked, 8400)}</w:tr>` +
      `<w:tr>${cell([V('{{#missing_data}}', ''), T('—')], marked, 600)}${cell([V('{{item}}', '[позиция перечня]'), V('{{/missing_data}}', '')], marked, 8400)}</w:tr></w:tbl>`,
    para([T('Предложение действует '), V('{{validity_days}}', '[срок]'), T(' календарных дней с даты письма.')], marked),
    para([T('Генеральный директор ООО «Демо-Подрядчик»                    И. И. Вымышленный')], marked),
  ].join('');
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${sect}</w:body></w:document>`;
};

for (const [name, marked] of [['demo-kp-letter.original.docx', false], ['demo-kp-letter.marked.docx', true]]) {
  write(name, [
    ['[Content_Types].xml', docxTypes],
    ['_rels/.rels', rootRels],
    ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', styles],
    ['word/footer1.xml', footer],
    ['word/numbering.xml', numbering],
    ['word/document.xml', letter(marked)],
  ]);
}

// ---------------------------------------------------------------- XLSX: существенные условия

const xlsxTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
const xlsxRootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Условия" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Условия!$A$1:$D$20</definedName></definedNames></workbook>`;
// Стили: 0 — обычный; 1 — заголовок (жирный, перенос, рамка); 2 — текст с переносом и рамкой; 3 — число с 2 знаками и
// рамкой; 4 — выделенное переменное место (заливка, как в реальных формах).
const xlsxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Liberation Sans"/></font><font><b/><sz val="10"/><name val="Liberation Sans"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const rows = [
  ['1', 'Цена договора', ['{{price_kind}}', '[вид цены]'], ''],
  ['2', 'Единицы измерения в сметной документации', ['{{estimate_units}}', '[единицы]'], ''],
  ['3', 'Компенсация содержания площадки за дополнительный месяц, млн руб.', { num: ['{{site_upkeep_month}}', '[сумма]'] }, ''],
  ['4', 'Срок выполнения работ до заключения о соответствии', ['{{duration_months}} мес.', '[срок] мес.'], ''],
  ['5', 'Срок передачи объекта и подписания итогового акта', ['{{handover_months}} мес.', '[срок] мес.'], ''],
  ['6', 'Общий аванс', ['{{advance_percent}} % от цены договора', '[аванс] % от цены договора'], ['{{customer_advance_percent}} % от цены договора', '[позиция заказчика] % от цены договора']],
  ['7', 'Обеспечение аванса', ['{{advance_security}}', '[обеспечение]'], ''],
  ['8', 'Гарантийное удержание', ['{{retention_percent}} %', '[удержание] %'], ''],
  ['9', 'Оплата выполненных работ', ['в течение {{payment_days}} рабочих дней после подписания актов', 'в течение [срок] рабочих дней после подписания актов'], ''],
  ['10', 'Механизм компенсации роста стоимости материалов', ['{{compensation_mechanism}}', '[механизм]'], ''],
  ['11', 'Порог накопленной инфляции', ['{{inflation_threshold}} %', '[порог] %'], ''],
  ['12', 'Коридор базовой стоимости материалов', ['{{basket_corridor}} %', '[коридор] %'], ''],
  ['13', 'Вариант методики определения стоимости ресурсов', ['{{methodology_variant}}', '[вариант]'], ''],
  ['14', 'Гарантийные сроки', ['{{warranty_months}} мес.; отделка и благоустройство — {{warranty_finishing_months}} мес.', '[срок] мес.; отделка и благоустройство — [срок] мес.'], ''],
  ['15', 'Позиция заказчика по остальным условиям', '', ['{{customer_notes}}', '[позиция заказчика]']],
  ['16', 'Работы, не предусмотренные договором', ['{{not_included}}', '[перечень]'], ''],
  ['17', 'К вниманию заказчика', ['{{attention}}', '[перечень]'], ''],
];

const keyConditions = (marked) => {
  const sst = [];
  const si = (t) => {
    sst.push(t);
    return sst.length - 1;
  };
  const c = (ref, style, value) => (value === '' ? `<c r="${ref}" s="${style}"/>` : `<c r="${ref}" s="${style}" t="s"><v>${si(value)}</v></c>`);
  const variable = (ref, v) => {
    if (v === '') return `<c r="${ref}" s="2"/>`;
    if (v.num) return marked ? c(ref, 3, v.num[0]) : c(ref, 4, v.num[1]);
    return marked ? c(ref, 2, v[0]) : c(ref, 4, v[1]);
  };
  const data = [
    `<row r="1" ht="30" customHeight="1">${c('A1', 1, 'Существенные условия договора генерального подряда (демонстрационная форма, вымышленный текст)')}<c r="B1" s="1"/><c r="C1" s="1"/><c r="D1" s="1"/></row>`,
    `<row r="2">${c('A2', 1, '№')}${c('B2', 1, 'Наименование условия')}${c('C2', 1, 'Предлагаемое условие')}${c('D2', 1, 'Позиция заказчика')}</row>`,
    ...rows.map((r, i) => {
      const n = i + 3;
      return `<row r="${n}">${c(`A${n}`, 2, r[0])}${c(`B${n}`, 2, r[1])}${variable(`C${n}`, r[2])}${variable(`D${n}`, r[3])}</row>`;
    }),
  ].join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:D${rows.length + 2}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="12.75"/><cols><col min="1" max="1" width="5" customWidth="1"/><col min="2" max="2" width="38" customWidth="1"/><col min="3" max="3" width="48" customWidth="1"/><col min="4" max="4" width="34" customWidth="1"/></cols><sheetData>${data}</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`;
  return { sheet, sharedStrings };
};

for (const [name, marked] of [['demo-key-conditions.original.xlsx', false], ['demo-key-conditions.marked.xlsx', true]]) {
  const k = keyConditions(marked);
  write(name, [
    ['[Content_Types].xml', xlsxTypes],
    ['_rels/.rels', xlsxRootRels],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/workbook.xml', workbook],
    ['xl/styles.xml', xlsxStyles],
    ['xl/worksheets/sheet1.xml', k.sheet],
    ['xl/sharedStrings.xml', k.sharedStrings],
  ]);
}
