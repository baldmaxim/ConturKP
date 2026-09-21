// Разбор _results.md (docs/discovery.md §7.1). Текст блоков есть только здесь: в
// _blocks.json текста нет, там координаты и типы. Формат известен по одному образцу,
// поэтому автомат допускающий: незнакомая разметка даёт предупреждение, а не потерю текста.

export interface IMdLabeled {
  label: string;
  text: string;
}

export interface IMdSection {
  // Номер из заголовка страницы (`## Page 7`) — как он написан в файле, без трактовки.
  pageNumber: number | null;
  // Порядок появления страницы в файле: источник соответствия page_index, когда номер отсутствует.
  pageOrder: number;
  heading: string;
  ordinal: number | null;
  typeHint: string | null;
  // Текст блока без помеченных секций: именно он является распознанным текстом (I06).
  body: string;
  labels: IMdLabeled[];
}

export interface IMdPage {
  pageNumber: number | null;
  pageOrder: number;
  raw: string;
  // Помеченные секции вне блоков (например, штамп, выведенный на уровне страницы).
  labels: IMdLabeled[];
}

export interface IMdParse {
  documentTitle: string | null;
  pages: IMdPage[];
  sections: IMdSection[];
}

const LABEL_RE = /^[ \t]*\*\*\s*([^*:\n]{1,60}?)\s*:?\s*\*\*\s*:?[ \t]*(.*)$/;
const BLOCK_ORDINAL_RE = /#\s*(\d+)/;
const BLOCK_TYPE_RE = /\[([^\]\n]{1,40})\]/;

// Помеченная секция — строка вида «**Label:** текст». Тело секции продолжается до следующей
// метки. Текст до первой метки — исходный распознанный текст блока.
export const splitLabels = (body: string): { rest: string; labels: IMdLabeled[] } => {
  const lines = body.split('\n');
  const rest: string[] = [];
  const labels: IMdLabeled[] = [];
  let current: { label: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current) labels.push({ label: current.label, text: current.lines.join('\n').trim() });
    current = null;
  };
  for (const line of lines) {
    const m = LABEL_RE.exec(line);
    if (m) {
      flush();
      current = { label: m[1]!.trim(), lines: m[2] ? [m[2]] : [] };
      continue;
    }
    if (current) current.lines.push(line);
    else rest.push(line);
  }
  flush();
  return { rest: rest.join('\n').trim(), labels };
};

export const parseResultsMd = (md: string): IMdParse => {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const pages: IMdPage[] = [];
  const sections: IMdSection[] = [];
  let documentTitle: string | null = null;
  let page: IMdPage | null = null;
  let heading: { raw: string; ordinal: number | null; typeHint: string | null } | null = null;
  let buffer: string[] = [];

  const closeSection = (): void => {
    if (!heading) {
      // Текст до первого блока страницы: помеченные секции там тоже осмысленны (штамп страницы).
      if (page && buffer.length > 0) page.labels.push(...splitLabels(buffer.join('\n')).labels);
      buffer = [];
      return;
    }
    const { rest, labels } = splitLabels(buffer.join('\n'));
    sections.push({
      pageNumber: page?.pageNumber ?? null,
      pageOrder: page?.pageOrder ?? -1,
      heading: heading.raw,
      ordinal: heading.ordinal,
      typeHint: heading.typeHint,
      body: rest,
      labels,
    });
    heading = null;
    buffer = [];
  };

  for (const line of lines) {
    const h1 = /^#[ \t]+(.*)$/.exec(line);
    const h2 = /^##[ \t]+(.*)$/.exec(line);
    const h3 = /^###[ \t]+(.*)$/.exec(line);
    if (h3) {
      closeSection();
      const raw = h3[1]!.trim();
      heading = {
        raw,
        ordinal: BLOCK_ORDINAL_RE.exec(raw) ? Number(BLOCK_ORDINAL_RE.exec(raw)![1]) : null,
        typeHint: BLOCK_TYPE_RE.exec(raw) ? BLOCK_TYPE_RE.exec(raw)![1]!.trim().toLowerCase() : null,
      };
      continue;
    }
    if (h2) {
      closeSection();
      const raw = h2[1]!.trim();
      const n = /(\d+)/.exec(raw);
      page = { pageNumber: n ? Number(n[1]) : null, pageOrder: pages.length, raw, labels: [] };
      pages.push(page);
      continue;
    }
    if (h1) {
      closeSection();
      documentTitle ??= h1[1]!.trim();
      continue;
    }
    buffer.push(line);
  }
  closeSection();
  return { documentTitle, pages, sections };
};
