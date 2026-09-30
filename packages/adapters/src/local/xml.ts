// Разбор XML частей OOXML без DTD и сущностей (A38): объявление DOCTYPE или ENTITY — отказ, а не
// разрешение (защита от XXE и «миллиарда смешков»). Префиксы приводятся по URI пространства имён,
// поэтому документ с нестандартным префиксом разбирается так же, как с обычным.

export class UnsafeXmlError extends Error {}
export class MalformedXmlError extends Error {}

export interface IXmlHandlers {
  open: (name: string, attrs: Readonly<Record<string, string>>) => void;
  close: (name: string) => void;
  text: (text: string) => void;
}

export interface IXmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (IXmlNode | string)[];
}

// Переходные и строгие (ISO) URI OOXML → канонический префикс.
const KNOWN_NS: Readonly<Record<string, string>> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main': 'x',
  'http://purl.oclc.org/ooxml/spreadsheetml/main': 'x',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'pr',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'urn:schemas-microsoft-com:vml': 'v',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
};

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g;
const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const decodeEntities = (raw: string): string => {
  if (!raw.includes('&')) return raw;
  const out = raw.replace(ENTITY, (_m, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED[body] ?? '';
  });
  // Оставшийся амперсанд — неизвестная сущность или голый символ: в корректном OOXML его нет.
  if (raw.replace(ENTITY, '').includes('&')) throw new MalformedXmlError('неизвестная сущность XML');
  return out;
};

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Байты части → текст: UTF-16 по BOM, иначе строгий UTF-8. Невалидная кодировка — повреждение.
export const decodeXmlBytes = (bytes: Uint8Array): string => {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new MalformedXmlError('часть XML не в UTF-8 и не в UTF-16');
  }
};

// Потоковый разбор: имена элементов и атрибутов — «канонический_префикс:локальное_имя».
export const scanXml = (xml: string, h: IXmlHandlers): void => {
  const scopes: Map<string, string>[] = [new Map()];
  const stack: string[] = [];
  const resolve = (qname: string, scope: Map<string, string>, isAttr: boolean): string => {
    const colon = qname.indexOf(':');
    const prefix = colon >= 0 ? qname.slice(0, colon) : '';
    const local = colon >= 0 ? qname.slice(colon + 1) : qname;
    if (prefix === 'xml' || prefix === 'xmlns') return qname;
    if (!prefix && isAttr) return local;
    const uri = scope.get(prefix);
    if (uri === undefined) return prefix ? `${prefix}:${local}` : local;
    const canon = KNOWN_NS[uri];
    return canon ? `${canon}:${local}` : prefix ? `${prefix}:${local}` : local;
  };
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const text = xml.slice(i, textEnd);
      if (stack.length > 0) h.text(decodeEntities(text));
      else if (text.trim() !== '' && !(i === 0 && text === '\ufeff')) throw new MalformedXmlError('текст вне корневого элемента');
    }
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new MalformedXmlError('незакрытый комментарий');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new MalformedXmlError('незакрытый CDATA');
      if (stack.length > 0) h.text(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new UnsafeXmlError('объявление DOCTYPE или ENTITY в части OOXML не допускается');
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new MalformedXmlError('незакрытая инструкция обработки');
      i = end + 2;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) throw new MalformedXmlError('незакрытый тег');
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const qname = body.slice(1).trim();
      const scope = scopes[scopes.length - 1]!;
      const name = resolve(qname, scope, false);
      if (stack.pop() !== name) throw new MalformedXmlError(`несогласованный закрывающий тег ${qname}`);
      scopes.pop();
      h.close(name);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]/);
    const qname = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    if (!qname) throw new MalformedXmlError('пустое имя элемента');
    const rawAttrs: [string, string][] = [];
    const decls: [string, string][] = [];
    for (const m of inner.slice(qname.length).matchAll(ATTR)) {
      const key = m[1]!;
      const value = decodeEntities(m[2] ?? m[3] ?? '');
      if (key === 'xmlns') decls.push(['', value]);
      else if (key.startsWith('xmlns:')) decls.push([key.slice(6), value]);
      else rawAttrs.push([key, value]);
    }
    // Новая область имён — только у элемента с объявлениями: миллион ячеек листа не копирует карту.
    const parentScope = scopes[scopes.length - 1]!;
    const scope = decls.length > 0 ? new Map([...parentScope, ...decls]) : parentScope;
    const name = resolve(qname, scope, false);
    const attrs: Record<string, string> = {};
    for (const [k, v] of rawAttrs) attrs[resolve(k, scope, true)] = v;
    h.open(name, attrs);
    if (selfClosing) {
      h.close(name);
    } else {
      stack.push(name);
      scopes.push(scope);
    }
  }
  if (stack.length > 0) throw new MalformedXmlError(`незакрытый элемент ${stack[stack.length - 1]}`);
};

// Дерево для частей умеренного размера (тело DOCX, книга, стили, общие строки).
export const parseXmlTree = (xml: string): IXmlNode => {
  const root: IXmlNode = { name: '#document', attrs: {}, children: [] };
  const path: IXmlNode[] = [root];
  scanXml(xml, {
    open: (name, attrs) => {
      const node: IXmlNode = { name, attrs: { ...attrs }, children: [] };
      path[path.length - 1]!.children.push(node);
      path.push(node);
    },
    close: () => {
      path.pop();
    },
    text: (text) => {
      path[path.length - 1]!.children.push(text);
    },
  });
  const top = root.children.find((c): c is IXmlNode => typeof c !== 'string');
  if (!top) throw new MalformedXmlError('в части нет корневого элемента');
  return top;
};

export const elements = (node: IXmlNode, name?: string): IXmlNode[] =>
  node.children.filter((c): c is IXmlNode => typeof c !== 'string' && (name === undefined || c.name === name));

export const firstElement = (node: IXmlNode, name: string): IXmlNode | null => elements(node, name)[0] ?? null;

// Прямой текст узла (без вложенных элементов).
export const ownText = (node: IXmlNode): string => node.children.filter((c): c is string => typeof c === 'string').join('');
