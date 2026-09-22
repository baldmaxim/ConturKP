// Сборка импорта RDWeb: _blocks.json даёт страницы, координаты и типы, _results.md — текст.
// Соответствие строго по block_id. Производные поля модели (Summary, Description, Entities,
// Verification) становятся отдельными фрагментами model_description и не подмешиваются
// к распознанному тексту (I06). Неизвестное не отбрасывается, а помечается.
import { createHash } from 'node:crypto';
import { parseResultsMd, type IMdLabeled, type IMdSection } from './markdown.ts';
import { KNOWN_BLOCK_TYPES, RdwebBlocksSchema, SUPPORTED_COORDINATE_SPACE, SUPPORTED_SCHEMA_VERSION, type RdwebBlock } from './schema.ts';
import {
  DEFAULT_LIMITS,
  WarningBag,
  type IRdwebFragment,
  type IRdwebImport,
  type IRdwebLimits,
  type IRdwebPage,
  type RdwebFragmentKind,
  type RdwebResult,
} from './types.ts';

export interface IRdwebArchive {
  pdf: { memberPath: string; sha256: string } | null;
  blocksJson: string | null;
  resultsMd: string | null;
  resultsHtmlPresent: boolean;
  extras: string[];
  ignored: string[];
  // Небезопасные члены (выход за корень, ссылка, шифрование) — отказ всего архива, а не пропуск.
  unsafe: { memberPath: string; detail: string }[];
  corrupt: string | null;
  // Metadata выбранного комплекта не найдена рядом с совпавшим PDF (R04-08): описание расхождения.
  groupMismatch: string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export const normalizeText = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const KIND_OF_TYPE: Record<string, RdwebFragmentKind> = { text: 'text_block', image: 'image_block', stamp: 'stamp_block' };
const KIND_OF_LABEL: Record<string, RdwebFragmentKind> = {
  summary: 'summary',
  description: 'description',
  entities: 'entities',
  verification: 'verification',
};

// Номер листа из текста штампа. Не распознали — null: выдумывать номер листа нельзя,
// он не равен номеру страницы файла (discovery §7.1).
export const sheetLabelOf = (stampText: string): string | null => {
  const m = /(?:^|\s)лист[\s.:№-]*([0-9]{1,4}(?:\s*(?:из|\/)\s*[0-9]{1,4})?)/i.exec(stampText);
  return m ? m[1]!.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
};

// Координаты доказательства не «подправляются»: число вне [0,1] означает, что пространство
// экспорта не то, за которое мы его принимаем. Обрезка превратила бы такую ошибку в
// правдоподобную, но ложную область оригинала, а неверно нанесённая рамка хуже её
// отсутствия (I18, A17, R04-09). Поэтому координаты отбрасываются целиком, текст остаётся.
const inRange01 = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

const bboxOf = (coords: number[] | null | undefined, warn: (code: string, sample: string) => void, blockId: string): number[] | null => {
  if (!coords || coords.length !== 4 || coords.some((c) => !Number.isFinite(c))) {
    warn('coords_missing', blockId);
    return null;
  }
  if (!coords.every(inRange01)) {
    warn('coords_out_of_range', blockId);
    return null;
  }
  const [a, b, c, d] = coords as [number, number, number, number];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
};

const polygonOf = (points: (number | number[])[] | null | undefined, warn: (code: string, sample: string) => void, blockId: string): number[] | null => {
  if (!points || points.length === 0) return null;
  const flat: number[] = [];
  for (const p of points) {
    if (Array.isArray(p)) flat.push(...p.map(Number));
    else flat.push(Number(p));
  }
  if (flat.length < 6 || flat.length % 2 !== 0 || flat.some((n) => !Number.isFinite(n))) {
    warn('polygon_invalid', blockId);
    return null;
  }
  if (!flat.every(inRange01)) {
    warn('coords_out_of_range', blockId);
    return null;
  }
  return flat;
};

// Поиск block_id в заголовке секции markdown: сначала по хвосту после двоеточия и по
// отдельным токенам (O(1)), затем — вхождением, если блоков немного.
const findBlockId = (heading: string, byId: Map<string, RdwebBlock>): string | null => {
  const tail = heading.includes(':') ? heading.slice(heading.lastIndexOf(':') + 1).trim() : '';
  const tokens = [tail, ...heading.split(/[\s,;]+/)].map((t) => t.replace(/^[[(<"'`]+|[\])>"'`.,;]+$/g, '').trim()).filter(Boolean);
  for (const t of tokens) if (byId.has(t)) return t;
  if (byId.size <= 5000) for (const id of byId.keys()) if (heading.includes(id)) return id;
  return null;
};

interface IBuildState {
  fragments: IRdwebFragment[];
  totalChars: number;
  overflow: boolean;
  limits: IRdwebLimits;
  warn: (code: string, sample: string) => void;
}

// Детерминированное разбиение длинного текста: по границе строки, если она попадает в
// последнюю четверть части, иначе по кодовой точке — суррогатная пара не рвётся. Склейка
// частей в том же порядке возвращает исходный текст в точности (R04-06).
export const splitFragmentText = (text: string, max: number): string[] => {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    const head = rest.charCodeAt(cut - 1);
    if (head >= 0xd800 && head <= 0xdbff) cut -= 1;
    const nl = rest.lastIndexOf('\n', cut - 1);
    if (nl + 1 >= Math.floor(max * 0.75)) cut = nl + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
};

const pushFragment = (st: IBuildState, f: Omit<IRdwebFragment, 'text' | 'textSha256' | 'partIndex' | 'partTotal'> & { text: string }): void => {
  const normalized = normalizeText(f.text);
  if (normalized.length === 0) return;
  const parts = splitFragmentText(normalized, st.limits.maxFragmentChars);
  if (parts.length > 1) st.warn('text_split', f.fragmentKey);
  for (const [i, text] of parts.entries()) {
    st.totalChars += text.length;
    if (st.totalChars > st.limits.maxTotalTextChars) {
      st.overflow = true;
      return;
    }
    st.fragments.push({
      ...f,
      // Ключ части детерминирован и не зависит от числа уже собранных фрагментов.
      fragmentKey: parts.length > 1 ? `${f.fragmentKey}#p${i + 1}` : f.fragmentKey,
      text,
      textSha256: sha256(text),
      warnings: parts.length > 1 ? [...f.warnings, 'text_split'] : [...f.warnings],
      partIndex: i,
      partTotal: parts.length,
    });
  }
};

const labelKind = (label: string, warn: (code: string, sample: string) => void): RdwebFragmentKind => {
  const kind = KIND_OF_LABEL[label.toLowerCase()];
  if (kind) return kind;
  warn('unknown_section_label', label);
  return 'unknown_section';
};

export const importRdwebExport = (input: {
  archive: IRdwebArchive;
  // pdfPageCount — фактическое число страниц зарегистрированного оригинала. Считает вызывающий:
  // адаптер в файловую систему не ходит. Полнота меряется по нему, а не по составу экспорта (R04-03).
  expect: { pdfSha256: string; pdfPageCount: number };
  limits?: Partial<IRdwebLimits>;
}): RdwebResult<IRdwebImport> => {
  const a = input.archive;
  const limits: IRdwebLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const bag = new WarningBag();
  const warn = (code: string, sample: string): void => bag.add(code, sample);

  if (a.corrupt) return { ok: false, error: { code: 'archive_corrupt', message: a.corrupt } };
  if (a.unsafe.length > 0) {
    return { ok: false, error: { code: 'archive_unsafe', message: `${a.unsafe[0]!.memberPath}: ${a.unsafe[0]!.detail}` } };
  }
  if (a.groupMismatch) {
    return { ok: false, error: { code: 'export_group_mismatch', message: a.groupMismatch } };
  }
  if (!Number.isInteger(input.expect.pdfPageCount) || input.expect.pdfPageCount < 1) {
    return { ok: false, error: { code: 'pdf_unreadable', message: 'число страниц оригинала не определено' } };
  }
  if (!a.pdf) return { ok: false, error: { code: 'pdf_missing', message: 'в архиве нет PDF' } };
  if (a.pdf.sha256 !== input.expect.pdfSha256) {
    return { ok: false, error: { code: 'pdf_mismatch', message: 'PDF экспорта не совпадает с зарегистрированной редакцией' } };
  }
  if (a.blocksJson === null) return { ok: false, error: { code: 'blocks_json_missing', message: 'в архиве нет _blocks.json' } };
  if (a.resultsMd === null) return { ok: false, error: { code: 'results_md_missing', message: 'в архиве нет _results.md' } };

  let raw: unknown;
  try {
    raw = JSON.parse(a.blocksJson);
  } catch (err) {
    return { ok: false, error: { code: 'blocks_json_invalid', message: `_blocks.json не читается: ${(err as Error).message.slice(0, 200)}` } };
  }
  const parsed = RdwebBlocksSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: { code: 'blocks_json_invalid', message: `_blocks.json не соответствует схеме: ${first?.path.join('.')} ${first?.message}` } };
  }
  const doc = parsed.data;
  if (doc.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, error: { code: 'schema_version_unsupported', message: `версия схемы экспорта ${doc.schema_version} не поддерживается` } };
  }
  if (doc.coordinate_space !== SUPPORTED_COORDINATE_SPACE) {
    return { ok: false, error: { code: 'coordinate_space_unsupported', message: `пространство координат «${doc.coordinate_space}» не поддерживается` } };
  }
  if (doc.pages.length === 0) return { ok: false, error: { code: 'blocks_json_invalid', message: '_blocks.json не содержит страниц' } };
  if (doc.pages.length > limits.maxPages || doc.blocks.length > limits.maxBlocks) {
    return { ok: false, error: { code: 'too_large', message: `экспорт превышает пределы разбора: ${doc.pages.length} страниц, ${doc.blocks.length} блоков` } };
  }

  for (const m of a.ignored) warn('duplicate_member_role', m);
  for (const m of a.extras) warn('unexpected_member', m);
  if (!a.resultsHtmlPresent) warn('results_html_missing', 'html');

  // ---- страницы
  const pageMeta = new Map<number, { widthPx: number | null; heightPx: number | null; rotation: number; label: string | null }>();
  for (const p of doc.pages) {
    if (pageMeta.has(p.page_index)) {
      warn('duplicate_page_index', String(p.page_index));
      continue;
    }
    const rotation = ((Math.trunc(p.rotation ?? 0) % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) warn('rotation_unexpected', String(p.rotation));
    pageMeta.set(p.page_index, {
      widthPx: p.width_px ?? null,
      heightPx: p.height_px ?? null,
      rotation: [0, 90, 180, 270].includes(rotation) ? rotation : 0,
      label: p.page_label === null || p.page_label === undefined ? null : String(p.page_label),
    });
  }
  // Проверяемая база полноты — сам оригинал. Состав _blocks.json к ней только сопоставляется:
  // экспорт, «забывший» страницу, обязан давать неполноту, а не тихий complete (I18, R04-03).
  const pagesTotal = input.expect.pdfPageCount;
  // Предел числа страниц обязан считаться по оригиналу: именно из него строятся страницы
  // прогона и выделяются объекты, а не из перечня в экспорте (R04-11).
  if (pagesTotal > limits.maxPages) {
    return { ok: false, error: { code: 'too_large', message: `в оригинале ${pagesTotal} страниц, предел разбора — ${limits.maxPages}` } };
  }
  if (pageMeta.size !== pagesTotal) warn('blocks_page_count_mismatch', `${pageMeta.size} против ${pagesTotal} страниц PDF`);
  for (const pageIndex of pageMeta.keys()) if (pageIndex >= pagesTotal) warn('page_index_out_of_range', String(pageIndex));

  // ---- markdown
  const md = parseResultsMd(a.resultsMd);
  if (md.pages.length !== pagesTotal) warn('page_count_mismatch', `${md.pages.length} против ${pagesTotal}`);

  // Индекс страницы markdown: номер в заголовке трактуется как номер страницы файла
  // (page_index + 1). Не сошлось — берём порядок появления и отмечаем расхождение.
  const mdPageIndex = new Map<number, number>();
  for (const p of md.pages) {
    const byNumber = p.pageNumber !== null ? p.pageNumber - 1 : null;
    const index = byNumber !== null && byNumber < pagesTotal ? byNumber : p.pageOrder;
    if (byNumber !== null && byNumber !== index) warn('page_heading_mismatch', p.raw);
    mdPageIndex.set(p.pageOrder, index);
  }

  const byId = new Map<string, RdwebBlock>();
  for (const b of doc.blocks) {
    if (byId.has(b.block_id)) warn('duplicate_block_id', b.block_id);
    else byId.set(b.block_id, b);
  }

  const sectionOf = new Map<string, IMdSection>();
  const orphanSections: IMdSection[] = [];
  for (const s of md.sections) {
    const id = findBlockId(s.heading, byId);
    if (id === null) {
      orphanSections.push(s);
      warn('block_not_in_blocks_json', s.heading);
      continue;
    }
    if (sectionOf.has(id)) warn('duplicate_block_section', id);
    else sectionOf.set(id, s);
  }

  // ---- штампы: собираются по странице и дедуплицируются по тексту
  const stampsByPage = new Map<number, string[]>();
  const addStamp = (pageIndex: number | null, text: string): void => {
    if (pageIndex === null) return;
    const norm = normalizeText(text);
    if (norm.length === 0) return;
    const list = stampsByPage.get(pageIndex) ?? [];
    if (!list.includes(norm)) list.push(norm);
    stampsByPage.set(pageIndex, list);
  };
  const isStamp = (l: IMdLabeled): boolean => l.label.toLowerCase() === 'stamp' || l.label.toLowerCase() === 'штамп';
  const isCrop = (l: IMdLabeled): boolean => l.label.toLowerCase() === 'crop';
  for (const p of md.pages) for (const l of p.labels) if (isStamp(l)) addStamp(mdPageIndex.get(p.pageOrder) ?? null, l.text);
  for (const s of md.sections) for (const l of s.labels) if (isStamp(l)) addStamp(mdPageIndex.get(s.pageOrder) ?? null, l.text);

  const st: IBuildState = { fragments: [], totalChars: 0, overflow: false, limits, warn };
  // Заголовок «## Page N» сам по себе выводом не является: страница считается распознанной
  // только по содержательному признаку — полученному фрагменту либо блоку с явно
  // подтверждённым статусом обработки (R04-03).
  const pagesWithHeading = new Set<number>([...mdPageIndex.values()]);
  const pagesWithRecognizedBlock = new Set<number>();
  const counts: Record<string, number> = {
    blocks: doc.blocks.length,
    blocksWithText: 0,
    cropUrlsPresent: 0,
    cropUrlsAbsent: 0,
    cropUrlsFetched: 0,
    pagesInBlocksJson: pageMeta.size,
  };

  // ---- фрагменты блоков
  for (const b of doc.blocks) {
    if (!pageMeta.has(b.page_index)) warn('block_page_unknown', b.block_id);
    // Отсутствие статуса больше не значит «распознано»: молчание экспорта не доказательство.
    const declared = (b.status ?? b.export_status ?? '').trim().toLowerCase();
    // Блок за пределами оригинала не создаёт ссылку на несуществующую страницу: текст
    // сохраняется, но привязки к странице у него нет (R04-10).
    const pageKnown = b.page_index < pagesTotal;
    if (!pageKnown) warn('page_index_out_of_range', b.block_id);
    if (declared === 'recognized' && pageKnown) pagesWithRecognizedBlock.add(b.page_index);
    const type = b.block_type.toLowerCase();
    if (!(KNOWN_BLOCK_TYPES as readonly string[]).includes(type)) warn('unknown_block_type', b.block_type);
    const kind = KIND_OF_TYPE[type] ?? 'unknown_block';
    const rotation = pageMeta.get(b.page_index)?.rotation ?? null;
    const section = sectionOf.get(b.block_id) ?? null;
    const cropFromMd = section?.labels.find(isCrop)?.text.trim() ?? null;
    const cropUrl = (b.crop_url ?? '').trim() || cropFromMd || null;
    if (cropUrl) counts.cropUrlsPresent! += 1;
    else counts.cropUrlsAbsent! += 1;
    const geometry = {
      externalBlockId: b.block_id,
      ordinal: b.ordinal ?? null,
      pageIndex: pageKnown ? b.page_index : null,
      bboxNorm: bboxOf(b.coords_norm, warn, b.block_id),
      bboxSpace: 'page_rotated' as const,
      shapeType: (b.shape_type ?? '').toLowerCase() === 'polygon' ? ('polygon' as const) : ('rectangle' as const),
      polygonNorm: polygonOf(b.polygon_points, warn, b.block_id),
      rotation,
      externalCropUrl: cropUrl ? cropUrl.slice(0, 2000) : null,
      warnings: [...(kind === 'unknown_block' ? ['unknown_block_type'] : []), ...(pageKnown ? [] : ['page_index_out_of_range'])],
    };
    if (geometry.shapeType === 'rectangle') geometry.polygonNorm = null;
    if (section && section.body.length > 0) {
      counts.blocksWithText! += 1;
      pushFragment(st, {
        ...geometry,
        origin: 'recognized_text',
        fragmentKind: kind,
        fragmentKey: `block:${b.block_id}:text`,
        derivedModelRef: null,
        text: section.body,
      });
    }
    for (const l of section?.labels ?? []) {
      if (isStamp(l) || isCrop(l)) continue;
      const lk = labelKind(l.label, warn);
      pushFragment(st, {
        ...geometry,
        origin: 'model_description',
        fragmentKind: lk,
        fragmentKey: `block:${b.block_id}:${l.label.toLowerCase().slice(0, 40)}`,
        derivedModelRef: `rdweb_export:${l.label.toLowerCase().slice(0, 40)}`,
        text: l.text,
      });
    }
  }

  // Секции markdown без блока в _blocks.json: текст сохраняется без координат.
  for (const [orphanOrdinal, s] of orphanSections.entries()) {
    const rawPage = mdPageIndex.get(s.pageOrder) ?? null;
    const pageIndex = rawPage !== null && rawPage < pagesTotal ? rawPage : null;
    if (rawPage !== null && pageIndex === null) warn('page_index_out_of_range', s.heading);
    if (s.body.length === 0) continue;
    // Ключ детерминирован: число уже собранных фрагментов в него не входит (R04-06).
    const keyOrdinal = s.ordinal ?? `o${orphanOrdinal}`;
    const orphanWarnings = ['block_not_in_blocks_json', ...(rawPage !== null && pageIndex === null ? ['page_index_out_of_range'] : [])];
    pushFragment(st, {
      origin: 'recognized_text',
      fragmentKind: 'unknown_block',
      fragmentKey: `md:p${pageIndex ?? -1}:${keyOrdinal}:text`,
      externalBlockId: null,
      ordinal: s.ordinal ?? null,
      pageIndex,
      bboxNorm: null,
      bboxSpace: null,
      shapeType: null,
      polygonNorm: null,
      rotation: pageIndex !== null ? (pageMeta.get(pageIndex)?.rotation ?? null) : null,
      derivedModelRef: null,
      externalCropUrl: null,
      text: s.body,
      warnings: orphanWarnings,
    });
  }

  // ---- штампы: привязка к stamp-блокам страницы, когда количества совпали
  const sheetLabels = new Map<number, string>();
  for (const [pageIndex, texts] of stampsByPage) {
    const pageKnown = pageIndex < pagesTotal;
    if (!pageKnown) warn('page_index_out_of_range', `штамп страницы ${pageIndex}`);
    const stampBlocks = doc.blocks.filter((b) => b.page_index === pageIndex && b.block_type.toLowerCase() === 'stamp');
    stampBlocks.sort((x, y) => (x.ordinal ?? 0) - (y.ordinal ?? 0));
    const bound = stampBlocks.length === texts.length && texts.length > 0;
    if (!bound && stampBlocks.length > 0) warn('stamp_binding_ambiguous', `страница ${pageIndex}`);
    texts.forEach((text, i) => {
      const sheet = sheetLabelOf(text);
      if (sheet && !sheetLabels.has(pageIndex)) sheetLabels.set(pageIndex, sheet);
      const b = bound ? stampBlocks[i]! : null;
      pushFragment(st, {
        origin: 'recognized_text',
        fragmentKind: 'stamp_block',
        fragmentKey: b ? `block:${b.block_id}:stamp` : `stamp:p${pageIndex}:${i}`,
        externalBlockId: b?.block_id ?? null,
        ordinal: b?.ordinal ?? i,
        pageIndex: pageKnown ? pageIndex : null,
        bboxNorm: b ? bboxOf(b.coords_norm, warn, b.block_id) : null,
        bboxSpace: b ? 'page_rotated' : null,
        shapeType: b ? 'rectangle' : null,
        polygonNorm: null,
        rotation: pageMeta.get(pageIndex)?.rotation ?? null,
        derivedModelRef: null,
        externalCropUrl: null,
        text,
        warnings: [...(bound ? [] : ['stamp_binding_ambiguous']), ...(pageKnown ? [] : ['page_index_out_of_range'])],
      });
    });
  }

  if (st.overflow) {
    return { ok: false, error: { code: 'too_large', message: `суммарный текст экспорта превышает ${limits.maxTotalTextChars} символов` } };
  }

  // Фрагмент — содержательный признак обработки страницы: пустой текст в него не попадает.
  const pagesWithEvidence = new Set<number>();
  for (const f of st.fragments) if (f.pageIndex !== null) pagesWithEvidence.add(f.pageIndex);

  // Строка заводится на каждую страницу оригинала, а не только на перечисленные в экспорте.
  const pages: IRdwebPage[] = Array.from({ length: pagesTotal }, (_, pageIndex) => {
    const meta = pageMeta.get(pageIndex) ?? null;
    const recognized = pagesWithEvidence.has(pageIndex) || pagesWithRecognizedBlock.has(pageIndex);
    if (!recognized && pagesWithHeading.has(pageIndex)) warn('page_output_empty', String(pageIndex));
    return {
      pageIndex,
      pageLabel: meta?.label ?? String(pageIndex + 1),
      sheetLabel: sheetLabels.get(pageIndex) ?? null,
      widthPx: recognized ? meta?.widthPx ?? null : null,
      heightPx: recognized ? meta?.heightPx ?? null : null,
      rotation: meta?.rotation ?? 0,
      status: recognized ? ('recognized' as const) : ('missing' as const),
    };
  });
  const pagesRecognized = pages.filter((p) => p.status === 'recognized').length;

  counts.fragments = st.fragments.length;
  counts.textChars = st.totalChars;
  counts.stampFragments = st.fragments.filter((f) => f.fragmentKind === 'stamp_block').length;
  counts.modelDescriptions = st.fragments.filter((f) => f.origin === 'model_description').length;

  return {
    ok: true,
    value: {
      schemaVersion: String(doc.schema_version),
      documentName: doc.document_name ?? md.documentTitle ?? null,
      coordinateSpace: doc.coordinate_space,
      pagesTotal,
      pagesRecognized,
      status: pagesRecognized === pagesTotal ? 'complete' : 'partial',
      pages,
      fragments: st.fragments,
      warnings: bag.list(),
      counts,
    },
  };
};

// inspect() из docs/contracts/adapters.md §3: счётчики без текста, для сверки образца.
export const inspectRdwebBlocks = (blocksJson: string): RdwebResult<{ schemaVersion: number; documentName: string | null; pages: number; blocks: number; blockTypes: Record<string, number> }> => {
  let raw: unknown;
  try {
    raw = JSON.parse(blocksJson);
  } catch (err) {
    return { ok: false, error: { code: 'blocks_json_invalid', message: (err as Error).message } };
  }
  const parsed = RdwebBlocksSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: { code: 'blocks_json_invalid', message: parsed.error.issues[0]?.message ?? 'схема не распознана' } };
  const blockTypes: Record<string, number> = {};
  for (const b of parsed.data.blocks) blockTypes[b.block_type] = (blockTypes[b.block_type] ?? 0) + 1;
  return {
    ok: true,
    value: {
      schemaVersion: parsed.data.schema_version,
      documentName: parsed.data.document_name ?? null,
      pages: parsed.data.pages.length,
      blocks: parsed.data.blocks.length,
      blockTypes,
    },
  };
};
