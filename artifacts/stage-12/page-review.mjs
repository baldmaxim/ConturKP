// Этап 12: страницы демонстрационных форм для просмотра человеком (D-032 В-12-10 — автоматические проверки дополняются
// просмотром страниц). Обе формы заполняются «тяжёлыми» значениями — длинный текст с переносами, кириллица, таблица с
// длинной строкой, скрытые условные блоки, денежное поле — в тестовом режиме (отметки видны), генерируются по
// размеченным копиям, переводятся LibreOffice в PDF; страницы сохраняются PNG, в журнал — число страниц, шрифты, подмена,
// остатки разметки. Тот же путь генерации, что у worker (renderDocx/renderXlsx → конвертер worker → renderPdfPages).
// Запуск: node artifacts/stage-12/page-review.mjs <каталог PNG> → artifacts/stage-12/page-review.log (PNG в Git не входят).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkMarkup, documentMarks, renderData, substitutedFonts } from '../../packages/core/src/index.ts';
import { docxUsedFonts, inspectPdf, leftoverTags, renderDocx, renderPdfPages, renderXlsx, scanDocxTags, scanXlsxTags, xlsxUsedFonts } from '../../packages/adapters/src/index.ts';
import { createOfficeConverter } from '../../apps/worker/src/office/libreoffice.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const outDir = resolve(process.argv[2] ?? join(ROOT, 'artifacts', 'stage-12', 'pages'));
mkdirSync(outDir, { recursive: true });
const schema = (name) => JSON.parse(readFileSync(join(ROOT, 'docs/forms', `${name}.forms.json`), 'utf8'));
const sample = (name) => readFileSync(join(ROOT, 'docs/forms/samples', name));
const LONG = 'Подрядчик выполняет работы в соответствии с проектной и рабочей документацией, техническим заданием и требованиями заказчика. ';

const forms = [
  {
    name: 'demo-kp-letter',
    format: 'docx',
    values: {
      letter_date: '2026-10-06',
      letter_number: '04/26-01-ТО',
      addressee: 'Тендерному управлению ООО «Заказчик-Демо»',
      subject: 'Строительство многоквартирного жилого дома с подземной автостоянкой и встроенно-пристроенными помещениями (демо)',
      materials_price_date: '2026-09-01',
      kp_price: '1234.5',
      advance_percent: '30',
      retention_percent: null,
      duration_months: '32',
      warranty_months: '60',
      inflation_threshold: '5',
      validity_days: '30',
      conditions_text: LONG.repeat(30).trim(),
      missing_data: [
        { item: 'Инженерно-геологические изыскания' },
        { item: `Технические условия на подключение: ${'водоснабжение, водоотведение, теплоснабжение, электроснабжение, связь; '.repeat(4).trim()}` },
        { item: 'Спецификации оборудования индивидуального теплового пункта' },
      ],
    },
  },
  {
    name: 'demo-key-conditions',
    format: 'xlsx',
    values: {
      price_kind: 'firm',
      estimate_units: 'Сметы составляются по этажам и секциям; единицы измерения — по ведомости объёмов работ заказчика.',
      site_upkeep_month: '25.5',
      duration_months: '32',
      handover_months: '36',
      advance_percent: '30',
      advance_security: 'bank_guarantee',
      retention_percent: '5',
      payment_days: '15',
      compensation_mechanism: 'inflation_and_basket',
      inflation_threshold: '5',
      basket_corridor: '10',
      methodology_variant: 'inflation_and_basket',
      warranty_months: '60',
      warranty_finishing_months: '24',
      customer_advance_percent: '20',
      customer_notes: LONG.repeat(3).trim(),
      not_included: [
        { item: 'Наружные сети водоснабжения и канализации', note: 'по отдельному договору' },
        { item: 'Благоустройство прилегающей территории за границей участка', note: LONG.trim() },
      ],
      attention: [{ item: 'Сроки поставки лифтового оборудования' }, { item: 'Согласование архитектурно-градостроительного облика' }],
    },
  },
];

const converter = createOfficeConverter({ sofficePath: process.env.SOFFICE_PATH ?? null, convertTimeoutMs: 120_000 });
if (!converter) {
  console.error('LibreOffice не найден (SOFFICE_PATH или PATH)');
  process.exit(1);
}
const lines = [`# page-review — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, ${await converter.version()}`];
let failed = false;
for (const f of forms) {
  const s = schema(f.name);
  const marked = sample(`${f.name}.marked.${f.format}`);
  const markup = checkMarkup(s, f.format, f.format === 'docx' ? scanDocxTags(marked) : scanXlsxTags(marked));
  const data = renderData(s, new Map(Object.entries(f.values)), f.format);
  const marks = documentMarks('test', true);
  const file = f.format === 'docx' ? renderDocx(marked, data, marks) : renderXlsx(marked, data, new Set(['site_upkeep_month']), marks);
  const pdf = await converter.toPdf(file, f.format);
  const info = await inspectPdf(pdf);
  const used = f.format === 'docx' ? docxUsedFonts(file) : xlsxUsedFonts(file);
  const substituted = substitutedFonts(used, info.fonts.filter((x) => x.embedded).map((x) => x.name));
  const left = leftoverTags(file, f.format);
  const pages = await renderPdfPages(pdf, 110);
  pages.forEach((png, i) => writeFileSync(join(outDir, `${f.name}-${String(i + 1).padStart(2, '0')}.png`), png));
  const ok = markup.ok && left.length === 0 && substituted.length === 0 && info.pages === pages.length;
  failed ||= !ok;
  lines.push(
    `${ok ? 'PASS' : 'FAIL'}  ${f.name}.${f.format}: страниц ${info.pages}, PNG ${pages.length}; разметка ${markup.ok ? 'ok' : 'ошибки'}; остатки разметки ${left.length}; шрифты ${used.join(', ')} → встроены ${info.fonts.filter((x) => x.embedded).map((x) => x.name).sort().join(', ')}; подмена ${substituted.length ? substituted.join(', ') : 'нет'}`,
  );
}
lines.push('Просмотр человеком: PNG страниц — в каталоге запуска; что проверено глазами — в отчёте этапа (§ просмотр страниц).');
lines.push(`Итог: ${failed ? 'FAIL' : 'PASS'}`);
writeFileSync(join(ROOT, 'artifacts', 'stage-12', 'page-review.log'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
process.exit(failed ? 1 : 0);
