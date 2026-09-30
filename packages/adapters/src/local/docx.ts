// DOCX → одна логическая единица «тело документа» (AD-05a-1: у DOCX нет стабильной пагинации
// без движка отображения, поэтому физической страницы нет). Якорь фрагмента — номер блока тела,
// раздел, таблица, строка и ячейки. OCR не применяется (OD-5): картинки внутри документа текстом
// не считаются. Колонтитулы и примечания рецензента — не текст документа: учитываются как пропуски.
import { splitFragmentText } from '../rdweb/import.ts';
import { mainPart, openOoxmlPackage, readRelationships, resolvePartPath, type IOoxmlPackage } from './ooxmlPackage.ts';
import { normalizeLocalText, structuredUnitIssues, textMetrics } from './quality.ts';
import { LocalRecognitionError, type DocxPart, type ILocalFragment, type ILocalLimits, type ILocalResult, type LocalLocator } from './types.ts';
import { elements, type IXmlNode } from './xml.ts';

interface IDocxState {
  fragments: ILocalFragment[];
  skipped: Record<string, number>;
  issues: Set<string>;
  totalChars: number;
  limits: ILocalLimits;
}

const bump = (map: Record<string, number>, key: string, by = 1): void => {
  map[key] = (map[key] ?? 0) + by;
};

// Элементы-обёртки, содержимое которых — обычные блоки или прогоны.
const WRAPPERS = new Set(['w:sdt', 'w:sdtContent', 'w:customXml', 'w:smartTag', 'w:hyperlink', 'w:ins', 'w:fldSimple', 'w:dir', 'w:bdo']);

// Совместимость разметки: берётся первый вариант mc:Choice, запасной mc:Fallback — только без Choice.
// Иначе текст надписи попал бы в фрагменты дважды (DrawingML и VML).
const alternate = (node: IXmlNode): IXmlNode[] => {
  const choice = elements(node, 'mc:Choice')[0];
  return choice ? [choice] : elements(node, 'mc:Fallback').slice(0, 1);
};

// Текст абзаца: прогоны, табуляции, переносы. Удалённый текст правки и коды полей не выводятся;
// надписи (w:txbxContent) собираются отдельно и становятся блоками после абзаца.
const paragraphText = (p: IXmlNode, textboxes: IXmlNode[], st: IDocxState): string => {
  let out = '';
  const walk = (node: IXmlNode): void => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      switch (child.name) {
        case 'w:t':
          out += child.children.filter((c): c is string => typeof c === 'string').join('');
          break;
        case 'w:tab':
        case 'w:ptab':
          out += '\t';
          break;
        case 'w:br':
        case 'w:cr':
          out += '\n';
          break;
        case 'w:noBreakHyphen':
          out += '-';
          break;
        case 'w:del':
        case 'w:delText':
        case 'w:instrText':
        case 'w:delInstrText':
        case 'w:pPr':
        case 'w:rPr':
          break;
        case 'w:txbxContent':
          textboxes.push(child);
          break;
        case 'w:object':
        case 'w:pict':
        case 'w:drawing':
          if (child.name !== 'w:drawing') bump(st.skipped, 'embeddedObjects');
          walk(child);
          break;
        case 'mc:AlternateContent':
          for (const branch of alternate(child)) walk(branch);
          break;
        default:
          walk(child);
      }
    }
  };
  walk(p);
  return out;
};

const tableCellText = (tc: IXmlNode, st: IDocxState): string => {
  const parts: string[] = [];
  const visit = (node: IXmlNode): void => {
    for (const child of elements(node)) {
      if (child.name === 'w:p') {
        const boxes: IXmlNode[] = [];
        parts.push(paragraphText(child, boxes, st));
        for (const box of boxes) visit(box);
      } else if (child.name === 'w:tbl') {
        // Вложенная таблица плоско: строки — через перевод строки, ячейки — через « | ».
        for (const tr of rowsOf(child)) parts.push(cellsOf(tr).map((c) => tableCellText(c, st).replace(/\n+/g, ' ')).join(' | '));
      } else if (WRAPPERS.has(child.name)) {
        visit(child);
      } else if (child.name === 'mc:AlternateContent') {
        for (const branch of alternate(child)) visit(branch);
      }
    }
  };
  visit(tc);
  return parts.join('\n');
};

const unwrap = (node: IXmlNode, name: string): IXmlNode[] => {
  const out: IXmlNode[] = [];
  for (const child of elements(node)) {
    if (child.name === name) out.push(child);
    else if (WRAPPERS.has(child.name)) out.push(...unwrap(child, name));
    else if (child.name === 'mc:AlternateContent') for (const b of alternate(child)) out.push(...unwrap(b, name));
  }
  return out;
};
const rowsOf = (tbl: IXmlNode): IXmlNode[] => unwrap(tbl, 'w:tr');
const cellsOf = (tr: IXmlNode): IXmlNode[] => unwrap(tr, 'w:tc');

const pushFragment = (st: IDocxState, text: string, locator: LocalLocator, keyBase: string): void => {
  const normalized = normalizeLocalText(text);
  if (normalized === '') return;
  st.totalChars += normalized.length;
  if (st.totalChars > st.limits.maxTotalTextChars) throw new LocalRecognitionError('too_large', 'текст документа больше предела разбора');
  const parts = splitFragmentText(normalized, st.limits.maxFragmentChars);
  for (const [i, part] of parts.entries()) {
    st.fragments.push({
      unitIndex: 0,
      key: parts.length > 1 ? `${keyBase}#p${i + 1}` : keyBase,
      ordinal: st.fragments.length + 1,
      origin: 'document_text',
      text: part,
      locator,
      warnings: parts.length > 1 ? ['text_split'] : [],
      partIndex: i,
      partTotal: parts.length,
    });
  }
};

// Блоки части (тело, сноски): абзацы и таблицы по порядку; раздел меняется после абзаца со своим sectPr.
const walkBlocks = (container: IXmlNode, part: DocxPart, st: IDocxState, counters: { block: number; table: number; section: number }): void => {
  const keyPart = part === 'body' ? 'b' : part === 'footnotes' ? 'fn' : 'en';
  const visit = (node: IXmlNode): void => {
    for (const child of elements(node)) {
      if (child.name === 'w:p') {
        const boxes: IXmlNode[] = [];
        const text = paragraphText(child, boxes, st);
        counters.block += 1;
        pushFragment(st, text, { kind: 'docx_paragraph', part, block: counters.block, section: counters.section }, `${keyPart}${counters.block}`);
        for (const box of boxes) {
          bump(st.skipped, 'textboxesExtracted');
          visit(box);
        }
        const pPr = elements(child, 'w:pPr')[0];
        if (part === 'body' && pPr && elements(pPr, 'w:sectPr').length > 0) counters.section += 1;
      } else if (child.name === 'w:tbl') {
        counters.block += 1;
        counters.table += 1;
        const block = counters.block;
        const table = counters.table;
        for (const [r, tr] of rowsOf(child).entries()) {
          const cells = cellsOf(tr).map((tc) => tableCellText(tc, st).replace(/\n+/g, ' ').trim());
          if (cells.every((c) => c === '')) continue;
          pushFragment(
            st,
            cells.join(' | '),
            { kind: 'docx_table_row', part, block, section: counters.section, table, row: r + 1, cellFrom: 1, cellTo: Math.max(1, cells.length) },
            `${keyPart}${block}:t${table}:r${r + 1}`,
          );
        }
      } else if (child.name === 'w:altChunk') {
        // Внедрённый фрагмент HTML или RTF разборщиком не читается: документ прочитан частично (OD-6).
        st.issues.add('docx_alt_chunk');
      } else if (WRAPPERS.has(child.name)) {
        visit(child);
      } else if (child.name === 'mc:AlternateContent') {
        for (const branch of alternate(child)) visit(branch);
      }
    }
  };
  visit(container);
};

const readNotes = async (pkg: IOoxmlPackage, path: string, kind: 'footnotes' | 'endnotes', st: IDocxState): Promise<void> => {
  const root = await pkg.readXml(path);
  const tag = kind === 'footnotes' ? 'w:footnote' : 'w:endnote';
  const counters = { block: 0, table: 0, section: 1 };
  for (const note of elements(root, tag)) {
    // Разделители сносок — служебные, не текст.
    if (note.attrs['w:type'] === 'separator' || note.attrs['w:type'] === 'continuationSeparator' || note.attrs['w:type'] === 'continuationNotice') continue;
    walkBlocks(note, kind, st, counters);
  }
};

export const parseDocx = async (bytes: Buffer, limits: ILocalLimits): Promise<ILocalResult> => {
  if (bytes.length > limits.maxInputBytes) throw new LocalRecognitionError('too_large', `файл ${bytes.length} байт больше предела ${limits.maxInputBytes}`);
  const pkg = await openOoxmlPackage(bytes, limits);
  try {
    const main = await mainPart(pkg, 'word/document.xml');
    const root = await pkg.readXml(main);
    if (root.name !== 'w:document') throw new LocalRecognitionError('unsupported_structure', 'главная часть пакета — не документ Word');
    const body = elements(root, 'w:body')[0];
    if (!body) throw new LocalRecognitionError('unsupported_structure', 'в документе нет тела');
    const st: IDocxState = { fragments: [], skipped: {}, issues: new Set(), totalChars: 0, limits };
    walkBlocks(body, 'body', st, { block: 0, table: 0, section: 1 });
    const rels = await readRelationships(pkg, main);
    for (const rel of rels) {
      if (rel.external) {
        bump(st.skipped, 'externalLinks');
        continue;
      }
      const type = rel.type.split('/').pop() ?? '';
      const path = resolvePartPath(main, rel.target);
      if ((type === 'footnotes' || type === 'endnotes') && pkg.has(path)) await readNotes(pkg, path, type, st);
      else if (type === 'header' || type === 'footer') bump(st.skipped, 'headersFooters');
      else if (type === 'comments') bump(st.skipped, 'comments');
    }
    const text = st.fragments.map((f) => f.text).join('\n');
    const metrics = textMetrics(text);
    for (const issue of structuredUnitIssues(metrics)) st.issues.add(issue);
    const issues = [...st.issues].sort();
    return {
      units: [
        {
          index: 0,
          kind: 'docx_body',
          label: null,
          widthPx: null,
          heightPx: null,
          rotation: 0,
          status: st.fragments.length === 0 ? 'missing' : issues.length > 0 ? 'needs_review' : 'recognized',
          method: 'structured',
          metrics: { ...metrics, ocrConfidence: null, nativeChars: null },
          issues,
        },
      ],
      fragments: st.fragments,
      skipped: st.skipped,
      warnings: [],
      facts: {},
    };
  } finally {
    pkg.close();
  }
};
