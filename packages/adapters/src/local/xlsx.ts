// XLSX → по единице на лист с данными (AD-05a-1). Фрагмент — строка листа; якорь — имя листа, диапазон
// ячеек строки (A7:F7), номера строки и столбцов, объединённые ячейки. Значение формулы — сохранённое
// в файле, формулы не вычисляются; формула без сохранённого значения — признак неполноты (OD-6).
// Пустые листы единицами не становятся: пустой лист — не ошибка распознавания.
import { splitFragmentText } from '../rdweb/import.ts';
import { builtinFormat, formatNumber } from './numberFormat.ts';
import { mainPart, openOoxmlPackage, readRelationships, resolvePartPath, type IOoxmlPackage } from './ooxmlPackage.ts';
import { normalizeLocalText, structuredUnitIssues, textMetrics } from './quality.ts';
import { columnName, LocalRecognitionError, type ILocalFragment, type ILocalLimits, type ILocalResult, type ILocalUnit } from './types.ts';
import { decodeXmlBytes, elements, MalformedXmlError, ownText, scanXml, UnsafeXmlError, type IXmlNode } from './xml.ts';

interface IStyles {
  xfFormats: (number | null)[];
  custom: Map<number, string>;
}

interface ICell {
  col: number;
  text: string;
}

const REF = /^([A-Z]{1,3})([0-9]+)$/;

const columnNumber = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

const siText = (si: IXmlNode): string => {
  // Строка — прямой x:t либо прогоны x:r/x:t; фонетические подсказки x:rPh не выводятся.
  const direct = elements(si, 'x:t').map(ownText).join('');
  const runs = elements(si, 'x:r').map((r) => elements(r, 'x:t').map(ownText).join('')).join('');
  return direct + runs;
};

const readSharedStrings = async (pkg: IOoxmlPackage, path: string): Promise<string[]> => elements(await pkg.readXml(path), 'x:si').map(siText);

const readStyles = async (pkg: IOoxmlPackage, path: string): Promise<IStyles> => {
  const root = await pkg.readXml(path);
  const custom = new Map<number, string>();
  for (const f of elements(elements(root, 'x:numFmts')[0] ?? root, 'x:numFmt')) {
    const id = Number(f.attrs.numFmtId);
    if (Number.isInteger(id) && f.attrs.formatCode !== undefined) custom.set(id, f.attrs.formatCode);
  }
  const xfs = elements(elements(root, 'x:cellXfs')[0] ?? { name: '', attrs: {}, children: [] }, 'x:xf');
  return { xfFormats: xfs.map((xf) => (xf.attrs.numFmtId === undefined ? null : Number(xf.attrs.numFmtId))), custom };
};

const clean = (text: string): string => text.replace(/\r\n|\r|\n/g, ' ').replace(/[ \t]+/g, ' ').trim();

interface ISheetScan {
  rows: Map<number, ICell[]>;
  merges: string[];
  issues: Set<string>;
  cells: number;
}

// Лист читается потоково: миллион ячеек не строит дерево в памяти.
const scanSheet = (xml: string, ctx: { sst: string[]; styles: IStyles; date1904: boolean; cellBudget: number }): ISheetScan => {
  const out: ISheetScan = { rows: new Map(), merges: [], issues: new Set(), cells: 0 };
  let rowNo = 0;
  let col = 0;
  let cell: { col: number; t: string; s: number; hasFormula: boolean; value: string | null; inline: string } | null = null;
  let capture: 'v' | 'is_t' | null = null;
  let inRph = false;
  const fmtOf = (style: number): string | null => {
    const id = ctx.styles.xfFormats[style] ?? 0;
    if (id === null) return null;
    return ctx.styles.custom.get(id) ?? builtinFormat(id);
  };
  scanXml(xml, {
    open: (name, attrs) => {
      if (name === 'x:row') {
        const r = Number(attrs.r);
        rowNo = Number.isInteger(r) && r > 0 ? r : rowNo + 1;
        col = 0;
      } else if (name === 'x:c') {
        const m = REF.exec(attrs.r ?? '');
        col = m ? columnNumber(m[1]!) : col + 1;
        if (m && Number(m[2]) !== rowNo) out.issues.add('cell_outside_row');
        cell = { col, t: attrs.t ?? 'n', s: Number(attrs.s ?? 0) || 0, hasFormula: false, value: null, inline: '' };
        out.cells += 1;
        if (out.cells > ctx.cellBudget) throw new LocalRecognitionError('too_large', 'ячеек в книге больше предела разбора');
      } else if (cell && name === 'x:f') {
        cell.hasFormula = true;
      } else if (cell && name === 'x:v') {
        capture = 'v';
        cell.value = '';
      } else if (cell && name === 'x:rPh') {
        inRph = true;
      } else if (cell && name === 'x:t' && !inRph) {
        capture = 'is_t';
      } else if (name === 'x:mergeCell' && attrs.ref) {
        out.merges.push(attrs.ref);
      }
    },
    close: (name) => {
      if (name === 'x:v' || name === 'x:t') capture = null;
      else if (name === 'x:rPh') inRph = false;
      else if (name === 'x:c' && cell) {
        const c = cell;
        cell = null;
        let text = '';
        if (c.t === 's') {
          const idx = Number(c.value);
          const str = Number.isInteger(idx) ? ctx.sst[idx] : undefined;
          if (str === undefined) out.issues.add('bad_shared_string');
          text = str ?? '';
        } else if (c.t === 'inlineStr') text = c.inline;
        else if (c.t === 'str' || c.t === 'e' || c.t === 'd') text = c.value ?? '';
        else if (c.t === 'b') text = c.value === null ? '' : c.value === '1' ? 'TRUE' : 'FALSE';
        else if (c.value !== null && c.value !== '') text = formatNumber(c.value, fmtOf(c.s), ctx.date1904);
        if (c.hasFormula && (c.value === null || c.value === '')) out.issues.add('formula_without_value');
        const value = clean(text);
        if (value !== '') {
          const list = out.rows.get(rowNo) ?? [];
          list.push({ col: c.col, text: value });
          out.rows.set(rowNo, list);
        }
      }
    },
    text: (text) => {
      if (!cell) return;
      if (capture === 'v') cell.value = (cell.value ?? '') + text;
      else if (capture === 'is_t') cell.inline += text;
    },
  });
  return out;
};

const intersects = (ref: string, row: number): boolean => {
  const [a, b] = ref.split(':');
  const ma = REF.exec(a ?? '');
  const mb = REF.exec(b ?? a ?? '');
  if (!ma || !mb) return false;
  return Number(ma[2]) <= row && row <= Number(mb[2]);
};

export const parseXlsx = async (bytes: Buffer, limits: ILocalLimits): Promise<ILocalResult> => {
  if (bytes.length > limits.maxInputBytes) throw new LocalRecognitionError('too_large', `файл ${bytes.length} байт больше предела ${limits.maxInputBytes}`);
  const pkg = await openOoxmlPackage(bytes, limits);
  try {
    const main = await mainPart(pkg, 'xl/workbook.xml');
    const wb = await pkg.readXml(main);
    if (wb.name !== 'x:workbook') throw new LocalRecognitionError('unsupported_structure', 'главная часть пакета — не книга Excel');
    const pr = elements(wb, 'x:workbookPr')[0];
    const date1904 = pr?.attrs.date1904 === '1' || pr?.attrs.date1904 === 'true';
    const rels = await readRelationships(pkg, main);
    const byId = new Map(rels.map((r) => [r.id, r]));
    const relOf = (type: string) => rels.find((r) => !r.external && r.type.endsWith(`/${type}`));
    const sstRel = relOf('sharedStrings');
    const stylesRel = relOf('styles');
    const sst = sstRel ? await readSharedStrings(pkg, resolvePartPath(main, sstRel.target)) : [];
    const styles = stylesRel ? await readStyles(pkg, resolvePartPath(main, stylesRel.target)) : { xfFormats: [], custom: new Map<number, string>() };
    const skipped: Record<string, number> = {};
    const bump = (k: string): void => {
      skipped[k] = (skipped[k] ?? 0) + 1;
    };
    const units: ILocalUnit[] = [];
    const fragments: ILocalFragment[] = [];
    let cellBudget = limits.maxCells;
    let totalChars = 0;
    let hidden = 0;
    const sheetList = elements(elements(wb, 'x:sheets')[0] ?? wb, 'x:sheet');
    if (sheetList.length === 0) throw new LocalRecognitionError('unsupported_structure', 'в книге нет листов');
    for (const sheet of sheetList) {
      const rel = byId.get(sheet.attrs['r:id'] ?? '');
      const type = rel?.type.split('/').pop() ?? '';
      if (!rel || rel.external) {
        bump('unresolvedSheets');
        continue;
      }
      if (type !== 'worksheet') {
        bump('nonWorksheetSheets');
        continue;
      }
      const path = resolvePartPath(main, rel.target);
      let scan: ISheetScan;
      try {
        scan = scanSheet(decodeXmlBytes(await pkg.read(path)), { sst, styles, date1904, cellBudget });
      } catch (err) {
        if (err instanceof UnsafeXmlError) throw new LocalRecognitionError('unsafe_package', `лист: ${err.message}`);
        if (err instanceof MalformedXmlError) throw new LocalRecognitionError('file_corrupt', `лист повреждён: ${err.message}`);
        throw err;
      }
      cellBudget -= scan.cells;
      if (scan.rows.size === 0) {
        bump('emptySheets');
        continue;
      }
      const index = units.length;
      const rawName = sheet.attrs.name ?? '';
      const name = rawName.slice(0, 31) || `Лист ${index + 1}`;
      if (rawName.length > 31 || rawName === '') scan.issues.add('sheet_name_invalid');
      if (sheet.attrs.state === 'hidden' || sheet.attrs.state === 'veryHidden') hidden += 1;
      const texts: string[] = [];
      for (const rowNo of [...scan.rows.keys()].sort((a, b) => a - b)) {
        const cells = scan.rows.get(rowNo)!.sort((a, b) => a.col - b.col);
        const colFrom = cells[0]!.col;
        const colTo = cells[cells.length - 1]!.col;
        const text = normalizeLocalText(cells.map((c) => c.text).join(' | '));
        totalChars += text.length;
        if (totalChars > limits.maxTotalTextChars) throw new LocalRecognitionError('too_large', 'текст книги больше предела разбора');
        texts.push(text);
        const merged = scan.merges.filter((m) => intersects(m, rowNo)).sort();
        const parts = splitFragmentText(text, limits.maxFragmentChars);
        for (const [i, part] of parts.entries()) {
          fragments.push({
            unitIndex: index,
            key: parts.length > 1 ? `s${index + 1}:r${rowNo}#p${i + 1}` : `s${index + 1}:r${rowNo}`,
            ordinal: fragments.length + 1,
            origin: 'document_text',
            text: part,
            locator: {
              kind: 'xlsx_cells',
              sheet: name,
              sheetIndex: index + 1,
              range: `${columnName(colFrom)}${rowNo}:${columnName(colTo)}${rowNo}`,
              rowFrom: rowNo,
              rowTo: rowNo,
              colFrom,
              colTo,
              ...(merged.length > 0 ? { merged } : {}),
            },
            warnings: parts.length > 1 ? ['text_split'] : [],
            partIndex: i,
            partTotal: parts.length,
          });
        }
      }
      const metrics = textMetrics(texts.join('\n'));
      const issues = [...new Set([...scan.issues, ...structuredUnitIssues(metrics)])].sort();
      units.push({
        index,
        kind: 'xlsx_sheet',
        label: name,
        widthPx: null,
        heightPx: null,
        rotation: 0,
        status: issues.length > 0 ? 'needs_review' : 'recognized',
        method: 'structured',
        metrics: { ...metrics, ocrConfidence: null, nativeChars: null },
        issues,
      });
    }
    return { units, fragments, skipped, warnings: [], facts: { sheets: sheetList.length, hiddenSheets: hidden, date1904 } };
  } finally {
    pkg.close();
  }
};
