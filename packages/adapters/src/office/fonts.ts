// Шрифты, которыми набран текст документа (D-032 В-12-2: подмена шрифтов при конвертации видна и не даёт сборке
// пройти). DOCX: шрифт фрагмента с непробельным текстом — свой (w:rFonts), иначе стиль символа, стиль абзаца по цепочке
// basedOn, затем умолчания документа; ссылки на тему — шрифты темы. Кириллица и прочий не-ASCII текст — w:hAnsi,
// ASCII — w:ascii. XLSX: шрифт стиля непустой ячейки и шрифты фрагментов форматированного текста.
import type PizZip from 'pizzip';
import { cellTexts, docxTextParts, openPackage } from './ooxml.ts';

interface IFonts {
  ascii?: string;
  hAnsi?: string;
}

const attr = (xml: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(xml)?.[1];

const themeFonts = (zip: PizZip): { major: string | undefined; minor: string | undefined } => {
  const theme = Object.keys(zip.files).find((n) => /^word\/theme\/theme\d*\.xml$/u.test(n));
  const xml = theme ? zip.file(theme)!.asText() : '';
  const latin = (tag: string) => attr(new RegExp(`<a:${tag}>[\\s\\S]*?<a:latin\\b[^>]*>`, 'u').exec(xml)?.[0] ?? '', 'typeface');
  return { major: latin('majorFont'), minor: latin('minorFont') };
};

const fontsOf = (rFonts: string | undefined, theme: { major: string | undefined; minor: string | undefined }): IFonts => {
  if (!rFonts) return {};
  const pick = (direct: string, themed: string): string | undefined => {
    const d = attr(rFonts, `w:${direct}`);
    if (d) return d;
    const t = attr(rFonts, `w:${themed}`);
    return t ? (t.startsWith('major') ? theme.major : theme.minor) : undefined;
  };
  return { ascii: pick('ascii', 'asciiTheme'), hAnsi: pick('hAnsi', 'hAnsiTheme') };
};

const merge = (a: IFonts, b: IFonts): IFonts => ({ ascii: a.ascii ?? b.ascii, hAnsi: a.hAnsi ?? b.hAnsi });

export const docxUsedFonts = (bytes: Buffer): string[] => {
  const zip = openPackage(bytes);
  const theme = themeFonts(zip);
  const styles = zip.file('word/styles.xml')?.asText() ?? '';
  const defaults = fontsOf(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/u.exec(styles)?.[0].match(/<w:rFonts\b[^>]*\/?>/u)?.[0], theme);
  const styleMap = new Map<string, { basedOn: string | undefined; fonts: IFonts }>();
  for (const m of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gu)) {
    const id = attr(m[1]!, 'w:styleId');
    if (!id) continue;
    styleMap.set(id, { basedOn: attr(/<w:basedOn\b[^>]*\/>/u.exec(m[2]!)?.[0] ?? '', 'w:val'), fonts: fontsOf(/<w:rPr>[\s\S]*?<\/w:rPr>/u.exec(m[2]!)?.[0].match(/<w:rFonts\b[^>]*\/?>/u)?.[0], theme) });
  }
  const defaultParagraphStyle = [...styles.matchAll(/<w:style\b([^>]*)>/gu)].map((m) => m[1]!).find((a) => attr(a, 'w:type') === 'paragraph' && attr(a, 'w:default') === '1');
  const styleFonts = (id: string | undefined, depth = 0): IFonts => {
    const s = id ? styleMap.get(id) : undefined;
    if (!s || depth > 20) return {};
    return merge(s.fonts, styleFonts(s.basedOn, depth + 1));
  };
  const used = new Set<string>();
  for (const part of docxTextParts(zip)) {
    const xml = zip.file(part)!.asText();
    for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)) {
      const pStyle = attr(/<w:pStyle\b[^>]*\/>/u.exec(p[0])?.[0] ?? '', 'w:val') ?? (defaultParagraphStyle ? attr(defaultParagraphStyle, 'w:styleId') : undefined);
      const paragraph = styleFonts(pStyle);
      for (const r of p[0].matchAll(/<w:r[ >][\s\S]*?<\/w:r>/gu)) {
        const text = [...r[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((t) => t[1]!).join('');
        if (text.trim() === '') continue;
        const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/u.exec(r[0])?.[0] ?? '';
        const own = fontsOf(rPr.match(/<w:rFonts\b[^>]*\/?>/u)?.[0], theme);
        const charStyle = styleFonts(attr(/<w:rStyle\b[^>]*\/>/u.exec(rPr)?.[0] ?? '', 'w:val'));
        const f = merge(merge(merge(own, charStyle), paragraph), defaults);
        // eslint-disable-next-line no-control-regex
        if (/[^\x00-\x7f]/u.test(text) && f.hAnsi) used.add(f.hAnsi);
        // eslint-disable-next-line no-control-regex
        if (/[\x21-\x7e]/u.test(text) && f.ascii) used.add(f.ascii);
      }
    }
  }
  return [...used].sort();
};

export const xlsxUsedFonts = (bytes: Buffer): string[] => {
  const zip = openPackage(bytes);
  const styles = zip.file('xl/styles.xml')?.asText() ?? '';
  const fonts = [...(/<fonts\b[\s\S]*?<\/fonts>/u.exec(styles)?.[0] ?? '').matchAll(/<font\b[\s\S]*?<\/font>|<font\s*\/>/gu)].map((m) => attr(/<name\b[^>]*\/>/u.exec(m[0])?.[0] ?? '', 'val'));
  const xfs = [...(/<cellXfs\b[\s\S]*?<\/cellXfs>/u.exec(styles)?.[0] ?? '').matchAll(/<xf\b[^>]*>/gu)].map((m) => Number(attr(m[0], 'fontId') ?? 0));
  const used = new Set<string>();
  for (const c of cellTexts(zip)) {
    if (c.text.trim() === '') continue;
    const name = fonts[xfs[c.style ?? 0] ?? 0];
    if (name) used.add(name);
  }
  const sst = zip.file('xl/sharedStrings.xml')?.asText() ?? '';
  for (const m of sst.matchAll(/<r>([\s\S]*?)<\/r>/gu)) {
    const font = attr(/<rFont\b[^>]*\/>/u.exec(m[1]!)?.[0] ?? '', 'val');
    const text = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/u.exec(m[1]!)?.[1] ?? '';
    if (font && text.trim() !== '') used.add(font);
  }
  return [...used].sort();
};
