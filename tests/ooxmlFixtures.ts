// Детерминированные построители синтетических пакетов OOXML для тестов этапа 05a: ZIP с фиксированной
// датой 1980-01-01 и сжатием deflate 9, XLSX и DOCX из частей XML. Одинаковый вход — байт в байт
// одинаковый файл (решение владельца по фикстуре XLSX, D-024). Файлы открываются стандартными
// разборщиками: проверка — artifacts/stage-05a/fixture-standard-parsers.log.
import { crc32, deflateRawSync } from 'node:zlib';

export interface IZipFile {
  name: string;
  data: string | Buffer;
  // Без сжатия: для проверок пределов распаковки и повреждений.
  store?: boolean;
}

const DOS_TIME = 0;
const DOS_DATE = 0x21;

export const buildZip = (files: IZipFile[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const packed = f.store ? data : deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---------------------------------------------------------------- XLSX

export type XStyle = 'general' | 'int' | 'date' | 'pct';
const STYLE_INDEX: Record<XStyle, number> = { general: 0, int: 1, date: 2, pct: 3 };

export interface IXCell {
  ref: string;
  // Строка — общая строка; число — числовое значение; boolean — логическое.
  v?: string | number | boolean;
  // Формула; cached — сохранённое значение (без него — формула без значения).
  f?: string;
  cached?: number;
  style?: XStyle;
  inline?: boolean;
}

export interface IXSheet {
  name: string;
  state?: 'hidden';
  cells: IXCell[];
  merges?: string[];
}

export const buildXlsx = (sheets: IXSheet[]): Buffer => {
  const sst: string[] = [];
  const sstIndex = (s: string): number => {
    const i = sst.indexOf(s);
    if (i >= 0) return i;
    sst.push(s);
    return sst.length - 1;
  };
  const sheetXml = (sh: IXSheet): string => {
    const rows = new Map<number, IXCell[]>();
    for (const c of sh.cells) {
      const row = Number(/[0-9]+$/.exec(c.ref)![0]);
      rows.set(row, [...(rows.get(row) ?? []), c]);
    }
    const body = [...rows.keys()]
      .sort((a, b) => a - b)
      .map((r) => {
        const cells = rows
          .get(r)!
          .map((c) => {
            const s = c.style ? ` s="${STYLE_INDEX[c.style]}"` : '';
            if (c.f !== undefined) {
              const v = c.cached === undefined ? '' : `<v>${c.cached}</v>`;
              return `<c r="${c.ref}"${s}><f>${esc(c.f)}</f>${v}</c>`;
            }
            if (typeof c.v === 'number') return `<c r="${c.ref}"${s}><v>${c.v}</v></c>`;
            if (typeof c.v === 'boolean') return `<c r="${c.ref}" t="b"><v>${c.v ? 1 : 0}</v></c>`;
            if (typeof c.v === 'string' && c.inline) return `<c r="${c.ref}" t="inlineStr"><is><t>${esc(c.v)}</t></is></c>`;
            if (typeof c.v === 'string') return `<c r="${c.ref}" t="s"><v>${sstIndex(c.v)}</v></c>`;
            return `<c r="${c.ref}"${s}/>`;
          })
          .join('');
        return `<row r="${r}">${cells}</row>`;
      })
      .join('');
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `${XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetData>${body}</sheetData>${merges}</worksheet>`;
  };
  const sheetParts = sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) }));
  const workbook =
    `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><workbookPr/><sheets>` +
    sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}"${sh.state ? ` state="${sh.state}"` : ''} r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const wbRels =
    `${XML}<Relationships xmlns="${NS_PR}">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const styles =
    `${XML}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
  // Общие строки собираются при построении листов, поэтому часть sharedStrings пишется после них.
  const sharedStrings = `${XML}<sst xmlns="${NS_MAIN}" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const contentTypes =
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const rootRels = `${XML}<Relationships xmlns="${NS_PR}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    ...sheetParts,
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
  ]);
};

// ---------------------------------------------------------------- DOCX

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export type DocxBlock =
  | { p: string; sectionBreak?: boolean; footnote?: number; link?: string }
  | { table: string[][] }
  | { raw: string };

export interface IDocxSpec {
  blocks: DocxBlock[];
  footnotes?: { id: number; text: string }[];
  header?: string;
  // Подмена тела документа целиком — для проверок безопасности разбора.
  documentXml?: string;
  extraParts?: IZipFile[];
}

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

export const buildDocx = (spec: IDocxSpec): Buffer => {
  const rels: string[] = [];
  const blocks = spec.blocks
    .map((b) => {
      if ('raw' in b) return b.raw;
      if ('table' in b) {
        const rows = b.table.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p>${c === '' ? '' : run(c)}</w:p></w:tc>`).join('')}</w:tr>`).join('');
        return `<w:tbl><w:tblPr/>${rows}</w:tbl>`;
      }
      const sect = b.sectionBreak ? '<w:pPr><w:sectPr/></w:pPr>' : '';
      let link = '';
      if (b.link) {
        const id = `rIdL${rels.length + 1}`;
        rels.push(`<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${esc(b.link)}" TargetMode="External"/>`);
        link = `<w:hyperlink r:id="${id}">${run(' ссылка')}</w:hyperlink>`;
      }
      const note = b.footnote === undefined ? '' : `<w:r><w:footnoteReference w:id="${b.footnote}"/></w:r>`;
      return `<w:p>${sect}${run(b.p)}${link}${note}</w:p>`;
    })
    .join('');
  const document = spec.documentXml ?? `${XML}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${blocks}<w:sectPr/></w:body></w:document>`;
  const parts: IZipFile[] = [];
  if (spec.footnotes) {
    rels.push(`<Relationship Id="rIdF" Type="${REL}/footnotes" Target="footnotes.xml"/>`);
    const notes = spec.footnotes.map((n) => `<w:footnote w:id="${n.id}"><w:p>${run(n.text)}</w:p></w:footnote>`).join('');
    parts.push({
      name: 'word/footnotes.xml',
      data: `${XML}<w:footnotes xmlns:w="${NS_W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>${notes}</w:footnotes>`,
    });
  }
  if (spec.header !== undefined) {
    rels.push(`<Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/>`);
    parts.push({ name: 'word/header1.xml', data: `${XML}<w:hdr xmlns:w="${NS_W}"><w:p>${run(spec.header)}</w:p></w:hdr>` });
  }
  const contentTypes =
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="${NS_PR}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="${NS_PR}">${rels.join('')}</Relationships>` },
    ...parts,
    ...(spec.extraParts ?? []),
  ]);
};
