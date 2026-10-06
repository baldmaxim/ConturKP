// Разметка и генерация документов по размеченному образцу (этап 12; D-032 В-12-3; ADR-013 п. 2–3).
// Сканер извлекает теги {{…}} из абзацев DOCX (включая разорванные Word на несколько фрагментов) и ячеек XLSX; проверку
// по схеме делает ядро (`checkMarkup`). Генератор: DOCX — docxtemplater поверх pizzip, остальное содержимое пакета не
// меняется; XLSX — замена текста ячеек в общих строках и строках ячейки, книга не пересохраняется сторонним движком
// (сохраняются область печати, объединения, стили, формулы). Значение — данные, а не разметка (I16). Отметки режима и
// демо-шаблона — видимым текстом в документе (D-032 В-12-8). Запись ZIP детерминированна.
import { randomBytes } from 'node:crypto';
import Docxtemplater from 'docxtemplater';
import type PizZip from 'pizzip';
import { tagsOfText, type IMarkupTag, type RenderValue } from '@kontur/core';
import { cellTexts, decodeXml, DOCX_PART_TITLE, docxParagraphTexts, docxTextParts, encodeXml, OfficeError, openPackage, sheets, writePackage } from './ooxml.ts';

// ---------------------------------------------------------------- Сканер разметки

export const scanDocxTags = (bytes: Buffer): IMarkupTag[] => {
  const zip = openPackage(bytes);
  const out: IMarkupTag[] = [];
  for (const part of docxTextParts(zip)) {
    docxParagraphTexts(zip.file(part)!.asText()).forEach((text, i) => out.push(...tagsOfText(text, `${DOCX_PART_TITLE(part)}, абзац ${i + 1}`)));
  }
  return out;
};

export const scanXlsxTags = (bytes: Buffer): IMarkupTag[] => cellTexts(openPackage(bytes)).flatMap((c) => tagsOfText(c.text, `${c.sheet}!${c.ref}`));

// Остатки разметки в готовом документе: «{{», «}}» в тексте любой части. Значения проверяются отдельно (пробная
// генерация с нейтральными значениями), поэтому фигурные скобки из текста значения не дают ложной тревоги.
export const leftoverTags = (bytes: Buffer, format: 'docx' | 'xlsx'): string[] => {
  const zip = openPackage(bytes);
  const texts =
    format === 'docx'
      ? docxTextParts(zip).flatMap((part) => docxParagraphTexts(zip.file(part)!.asText()).map((t, i) => ({ t, where: `${DOCX_PART_TITLE(part)}, абзац ${i + 1}` })))
      : cellTexts(zip).map((c) => ({ t: c.text, where: `${c.sheet}!${c.ref}` }));
  return texts.filter((x) => x.t.includes('{{') || x.t.includes('}}')).map((x) => x.where);
};

// ---------------------------------------------------------------- DOCX

const MARK_RUN = (text: string) =>
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p>`;

const markDocx = (zip: PizZip, marks: readonly string[]): void => {
  if (marks.length === 0) return;
  const f = zip.file('word/document.xml')!;
  const xml = f.asText();
  const at = xml.search(/<w:body>/u);
  if (at < 0) throw new OfficeError('package_unreadable', 'в DOCX нет тела документа');
  zip.file('word/document.xml', `${xml.slice(0, at + 8)}${marks.map(MARK_RUN).join('')}${xml.slice(at + 8)}`);
};

// Абзац вне таблицы, целиком занятый одним блоком `{{#k}}…{{/k}}`: скрытый блок удаляет абзац, а не оставляет пустую
// строку (и номер автоматического списка без текста). Метка ставится отдельным фрагментом перед блоком, вне его; после
// заполнения абзац, где осталась только метка, удаляется, в остальных метка снимается. Абзацы с закладками, рисунками,
// полями, разрывом раздела и надписями не удаляются (остаются пустыми). Метка случайна и в результат не попадает.
const PARA_RE = /<w:p\b(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/w:p>/gu;
const KEEP_RE = /<w:(?:sectPr|bookmarkStart|bookmarkEnd|drawing|pict|object|fldChar|fldSimple|instrText|txbxContent|commentRange)\b/u;
const cellDepths = (xml: string): ((at: number) => number) => {
  const marks = [...xml.matchAll(/<w:tc\b(?:\s[^>]*?)?(?<!\/)>|<\/w:tc>/gu)].map((m) => ({ at: m.index, d: m[0].startsWith('</') ? -1 : 1 }));
  return (at) => marks.reduce((depth, m) => (m.at < at ? depth + m.d : depth), 0);
};
const paragraphText = (p: string): string => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((t) => decodeXml(t[1]!)).join('');

const markWholeBlocks = (xml: string, sentinel: string): string => {
  const depth = cellDepths(xml);
  return xml.replace(PARA_RE, (p, at: number) => {
    if (depth(at) > 0 || KEEP_RE.test(p)) return p;
    const tags = tagsOfText(paragraphText(p), '');
    const first = tags[0];
    const text = paragraphText(p).trim();
    if (!first || first.kind !== 'open' || !text.startsWith(first.raw) || !text.endsWith(`}}`)) return p;
    // Блок первого тега закрывается последним тегом абзаца и не раньше.
    let level = 0;
    for (const [i, t] of tags.entries()) {
      if (t.kind === 'open') level += 1;
      if (t.kind === 'close') level -= 1;
      if (level === 0 && i !== tags.length - 1) return p;
    }
    const last = tags[tags.length - 1]!;
    if (last.kind !== 'close' || last.key !== first.key || !text.endsWith(last.raw)) return p;
    const head = p.match(/^<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?/u)![0];
    return `${head}<w:r><w:t>${sentinel}</w:t></w:r>${p.slice(head.length)}`;
  });
};

const dropEmptyBlocks = (xml: string, sentinel: string): string =>
  xml.replace(PARA_RE, (p) => (p.includes(sentinel) ? (paragraphText(p) === sentinel ? '' : p.split(`<w:r><w:t>${sentinel}</w:t></w:r>`).join('').split(sentinel).join('')) : p));

export const renderDocx = (sample: Buffer, data: Record<string, RenderValue>, marks: readonly string[] = []): Buffer => {
  const zip = openPackage(sample);
  markDocx(zip, marks);
  const sentinel = `KKPDROP${randomBytes(12).toString('hex')}`;
  const parts = docxTextParts(zip);
  for (const part of parts) zip.file(part, markWholeBlocks(zip.file(part)!.asText(), sentinel));
  const tpl = new Docxtemplater(zip as never, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    // Простой тег неприменимого или пустого поля — пустая строка; блок — скрыт. Неизвестный ключ разметка не пропускает.
    parser: (tag: string) => ({
      get: (scope: Record<string, unknown>, context: { meta?: { part?: { module?: string } } }) => {
        if (tag === '.') return scope;
        if (scope === null || typeof scope !== 'object' || !(tag in scope)) return undefined;
        const v = scope[tag];
        return v === false && context?.meta?.part?.module !== 'loop' ? '' : v;
      },
    }),
    nullGetter: () => '',
  });
  try {
    tpl.render(data);
  } catch (err) {
    throw new OfficeError('render_failed', `образец не заполняется: ${(err as Error).message.slice(0, 300)}`);
  }
  const out = tpl.getZip() as unknown as PizZip;
  for (const part of parts) out.file(part, dropEmptyBlocks(out.file(part)!.asText(), sentinel));
  return writePackage(out);
};

// ---------------------------------------------------------------- XLSX

const TAG_RE = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/gu;
const PURE_TAG_RE = /^\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}$/u;
const textOf = (data: Record<string, RenderValue>, key: string): string => {
  const v = data[key];
  return typeof v === 'string' ? v : '';
};
const fillText = (text: string, data: Record<string, RenderValue>): string => text.replace(TAG_RE, (_, k: string) => textOf(data, k));
const tElement = (s: string) => `<t xml:space="preserve">${encodeXml(s)}</t>`;

// Число для ячейки: значение поля «1 234,5» → «1234.5» (ячейка становится числовой, формат — стиль образца).
const asCellNumber = (s: string): string | null => {
  const n = s.replace(/[ \s]/gu, '').replace(',', '.').replace('−', '-');
  // Каноническая запись без хвостовых нулей дробной части: знаки показывает формат ячейки образца.
  return /^-?\d+(\.\d+)?$/u.test(n) ? n.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '') : null;
};

export const renderXlsx = (sample: Buffer, data: Record<string, RenderValue>, numberKeys: ReadonlySet<string>, marks: readonly string[] = []): Buffer => {
  const zip = openPackage(sample);
  const sstFile = zip.file('xl/sharedStrings.xml');
  let sst = sstFile?.asText() ?? '';
  const items = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/gu)];
  const texts = items.map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((t) => decodeXml(t[1]!)).join(''));
  // Ячейка, целиком занятая плейсхолдером числового поля, становится числом; остальные — текст с подстановкой.
  const numericShared = new Map<number, string>();
  texts.forEach((t, i) => {
    const k = PURE_TAG_RE.exec(t)?.[1];
    const n = k && numberKeys.has(k) ? asCellNumber(textOf(data, k)) : null;
    if (n !== null) numericShared.set(i, n);
  });
  let idx = -1;
  sst = sst.replace(/<si>([\s\S]*?)<\/si>/gu, (whole) => {
    idx += 1;
    const t = texts[idx]!;
    return t.includes('{{') ? `<si>${tElement(fillText(t, data))}</si>` : whole;
  });
  const markText = marks.join(' · ');
  if (sstFile) zip.file('xl/sharedStrings.xml', sst);
  sheets(zip).forEach((sh, si) => {
    const f = zip.file(sh.part);
    if (!f) return;
    let xml = f.asText();
    xml = xml.replace(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/gu, (whole, attrs: string, body: string) => {
      const type = /\bt="([a-zA-Z]+)"/u.exec(attrs)?.[1];
      if (type === 's') {
        const i = Number(/<v>(\d+)<\/v>/u.exec(body)?.[1] ?? NaN);
        const n = numericShared.get(i);
        return n === undefined ? whole : `<c${attrs.replace(/\s*\bt="s"/u, '')}><v>${n}</v></c>`;
      }
      if (type === 'inlineStr') {
        const t = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((x) => decodeXml(x[1]!)).join('');
        if (!t.includes('{{')) return whole;
        const k = PURE_TAG_RE.exec(t)?.[1];
        const n = k && numberKeys.has(k) ? asCellNumber(textOf(data, k)) : null;
        return n !== null ? `<c${attrs.replace(/\s*\bt="inlineStr"/u, '')}><v>${n}</v></c>` : `<c${attrs}><is>${tElement(fillText(t, data))}</is></c>`;
      }
      return whole;
    });
    // Отметка — новой строкой над таблицей нельзя (сдвиг ссылок): первая текстовая ячейка листа получает отметку
    // перед своим текстом, а колонтитул печати — отметку целиком (видна и в PDF).
    if (markText) {
      xml = addHeaderMark(xml, markText);
      if (si === 0) xml = prefixFirstTextCell(zip, xml, markText);
    }
    zip.file(sh.part, xml);
  });
  return writePackage(zip);
};

const addHeaderMark = (xml: string, mark: string): string => {
  const code = `&amp;C&amp;"-,Bold"&amp;KC00000${encodeXml(mark)}`;
  if (/<oddHeader>/u.test(xml)) return xml.replace(/<oddHeader>([\s\S]*?)<\/oddHeader>/u, `<oddHeader>${code}</oddHeader>`);
  if (/<headerFooter[^>]*\/>/u.test(xml)) return xml.replace(/<headerFooter([^>]*)\/>/u, `<headerFooter$1><oddHeader>${code}</oddHeader></headerFooter>`);
  if (/<headerFooter[^>]*>/u.test(xml)) return xml.replace(/<headerFooter([^>]*)>/u, `<headerFooter$1><oddHeader>${code}</oddHeader>`);
  // Порядок элементов листа (CT_Worksheet): headerFooter — после pageSetup или pageMargins.
  const anchor = /<pageSetup\b[^>]*\/>|<pageSetup\b[\s\S]*?<\/pageSetup>/u.exec(xml) ?? /<pageMargins\b[^>]*\/>/u.exec(xml);
  if (anchor) return `${xml.slice(0, anchor.index + anchor[0].length)}<headerFooter><oddHeader>${code}</oddHeader></headerFooter>${xml.slice(anchor.index + anchor[0].length)}`;
  return xml.replace(/<\/worksheet>/u, `<headerFooter><oddHeader>${code}</oddHeader></headerFooter></worksheet>`);
};

const prefixFirstTextCell = (zip: PizZip, xml: string, mark: string): string => {
  const sstFile = zip.file('xl/sharedStrings.xml');
  let done = false;
  return xml.replace(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/gu, (whole, attrs: string, body: string) => {
    if (done) return whole;
    const type = /\bt="([a-zA-Z]+)"/u.exec(attrs)?.[1];
    if (type === 'inlineStr') {
      done = true;
      const t = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((x) => decodeXml(x[1]!)).join('');
      return `<c${attrs}><is>${tElement(`${mark}\n${t}`)}</is></c>`;
    }
    if (type === 's' && sstFile) {
      done = true;
      const i = Number(/<v>(\d+)<\/v>/u.exec(body)?.[1] ?? NaN);
      const sst = sstFile.asText();
      const items = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/gu)];
      const t = items[i] ? [...items[i]![1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((x) => decodeXml(x[1]!)).join('') : '';
      const n = items.length;
      zip.file(
        'xl/sharedStrings.xml',
        sst
          .replace(/<\/sst>/u, `<si>${tElement(`${mark}\n${t}`)}</si></sst>`)
          .replace(/uniqueCount="\d+"/u, `uniqueCount="${n + 1}"`)
          .replace(/(\s)count="(\d+)"/u, (_, sp: string, c: string) => `${sp}count="${Number(c) + 1}"`),
      );
      return `<c${attrs}><v>${n}</v></c>`;
    }
    return whole;
  });
};
