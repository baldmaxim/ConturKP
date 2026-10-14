// Сборка кандидата выпуска (этап 12; D-032; ADR-013; проект §5–§6). Генерация каждого документа по размеченной копии
// образца из закреплённых версий полей (текущими данными не подменяются), стандартные вложения «как есть», PDF-превью
// каждого файла конвертером LibreOffice, проверки (остатки разметки — пробной генерацией с нейтральными значениями;
// полнота отрисовки — каждое значение словами по порядку в тексте PDF; подмена и невстроенные шрифты; переполнение
// ячеек XLSX со своей высотой строки; числа, связанные с расчётом), манифест. Права создателя перепроверяются при
// сборке (D-032 В-12-7). Всё — одной транзакцией завершения; провал — «сборка не удалась» с причиной (I18).
import { Readable } from 'node:stream';
import {
  allFields,
  CALC_QUANTITIES,
  canonicalJson,
  compareWithCalculation,
  documentMarks,
  MANIFEST_SCHEMA,
  renderData,
  renderedTexts,
  substitutedFonts,
  tenderCapabilities,
  type FieldValue,
  type IFormSchema,
  type IManifest,
  type IManifestCheck,
  type IManifestFile,
  type INumberField,
  type RenderValue,
} from '@kontur/core';
import {
  cellTexts,
  detectFormat,
  docxUsedFonts,
  inspectPdf,
  leftoverTags,
  MEDIA_TYPES,
  OfficeError,
  openPackage,
  renderDocx,
  renderXlsx,
  xlsxUsedFonts,
  type IOfficeConverter,
  type OfficeFormat,
} from '@kontur/adapters';
import { createOfficeConverter } from '../office/libreoffice.ts';
import {
  candidateInputs,
  ensureRevisionEconomics,
  fieldVersionVisibility,
  finishCandidate,
  getCandidate,
  getDraft,
  getStandardAttachmentRevision,
  getTemplateRevision,
  insertBlob,
  loadAccessContext,
  memberRoleOf,
  type IFinishFile,
  type IReleaseCandidateRow,
} from '@kontur/db';
import { storageKeyOf } from '@kontur/storage';
import type { IJobContext, IJobHandlerSpec } from '../runtime.ts';

const MAX_FILE_BYTES = 128 * 1024 * 1024;

type Check = IManifestCheck & { outcome: 'passed' | 'failed' | 'unverified' | 'not_applicable' };

class AssemblyFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const safeName = (s: string): string => s.replace(/[/\\:*?"<>|\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'документ';
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Каждое слово значения есть в тексте PDF в том же порядке (между ними могут быть колонтитулы и переносы страниц).
const inOrder = (hay: readonly string[], needle: readonly string[]): boolean => {
  let i = 0;
  for (const w of hay) if (i < needle.length && w === needle[i]) i += 1;
  return i === needle.length;
};

// Нейтральные значения для пробной генерации: остатки разметки не путаются с фигурными скобками в тексте значения.
const neutral = (data: Record<string, RenderValue>): Record<string, RenderValue> =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === false ? false : typeof v === 'string' ? 'X' : v.map((r) => Object.fromEntries(Object.keys(r).map((c) => [c, 'X'])))]));

// Переполнение ячейки XLSX: ячейка, текст которой изменила генерация (значение или отметка), в строке со своей высотой
// (customHeight) не помещается по оценке «символов в строке ≈ ширина столбцов (с учётом объединения) × 1,1»,
// «строк ≈ высота / 12,75». Строки без своей высоты растут сами — их проверяет полнота отрисовки и просмотр человеком.
const colIndex = (col: string): number => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const xlsxOverflow = (bytes: Buffer, sample: Buffer): string[] => {
  const zip = openPackage(bytes);
  const before = new Map(cellTexts(openPackage(sample)).map((c) => [`${c.sheet}!${c.ref}`, c.text]));
  const out: string[] = [];
  for (const c of cellTexts(zip)) {
    if (before.get(`${c.sheet}!${c.ref}`) === c.text) continue;
    const xml = zip.file(c.part)!.asText();
    const row = Number(/\d+$/u.exec(c.ref)?.[0] ?? 0);
    const rowTag = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>`, 'u').exec(xml)?.[0] ?? '';
    if (!/customHeight="1"/u.test(rowTag)) continue;
    const ht = Number(/\bht="([\d.]+)"/u.exec(rowTag)?.[1] ?? 12.75);
    const col = colIndex(c.ref.replace(/\d+$/u, ''));
    const merge = [...xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/gu)].find((m) => m[1] === c.ref.replace(/\d+$/u, '') && Number(m[2]) === row);
    const last = merge ? colIndex(merge[3]!) : col;
    const cols = [...xml.matchAll(/<col\b[^>]*\/>/gu)].map((m) => m[0]);
    let width = 0;
    for (let k = col; k <= last; k += 1) {
      const tag = cols.find((t) => Number(/min="(\d+)"/u.exec(t)?.[1]) <= k && Number(/max="(\d+)"/u.exec(t)?.[1]) >= k);
      width += Number(/width="([\d.]+)"/u.exec(tag ?? '')?.[1] ?? 8.43);
    }
    const perLine = Math.max(1, Math.floor(width * 1.1));
    const lines = c.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    if (lines > Math.max(1, Math.floor(ht / 12.75))) out.push(`${c.sheet}!${c.ref}`);
  }
  return out;
};

interface IBuilt {
  files: IFinishFile[];
  manifestFiles: IManifestFile[];
  checks: Check[];
}

const storeBytes = async (ctx: IJobContext, bytes: Buffer, mediaType: string) => {
  const s = await ctx.store.putStream(Readable.from([bytes]), MAX_FILE_BYTES);
  return { sha256: s.sha256, size: s.sizeBytes, storageKey: s.storageKey, mediaType };
};

const readBlob = async (ctx: IJobContext, sha: string): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const ch of ctx.store.openRead(sha)) chunks.push(ch as Buffer);
  return Buffer.concat(chunks);
};

const previewOf = async (
  ctx: IJobContext,
  converter: IOfficeConverter,
  bytes: Buffer,
  format: OfficeFormat,
  path: string,
  checks: Check[],
  expectTexts: readonly string[],
): Promise<{ pdf: Buffer; pages: number; fonts: string[] }> => {
  let pdf: Buffer;
  try {
    pdf = format === 'pdf' ? bytes : await converter.toPdf(bytes, format, ctx.signal);
  } catch (err) {
    // Конвертация прервана остановкой, отменой или потерей аренды — это не отказ сборки.
    ctx.throwIfStopped();
    if (err instanceof OfficeError) throw new AssemblyFailure(err.code, `${path}: ${err.message}`);
    throw err;
  }
  let info;
  try {
    info = await inspectPdf(pdf);
  } catch (err) {
    throw new AssemblyFailure('conversion_failed', `${path}: ${(err as Error).message}`);
  }
  const embedded = info.fonts.filter((f) => f.embedded).map((f) => f.name);
  const notEmbedded = info.fonts.filter((f) => !f.embedded).map((f) => f.name);
  const requested = format === 'docx' ? docxUsedFonts(bytes) : format === 'xlsx' ? xlsxUsedFonts(bytes) : [];
  const substituted = substitutedFonts(requested, embedded);
  checks.push(
    substituted.length > 0 || notEmbedded.length > 0
      ? { code: 'font_substituted', outcome: 'failed', path, detail: `шрифты подменены или не встроены: ${[...substituted, ...notEmbedded].join(', ')}` }
      : { code: 'fonts_embedded', outcome: 'passed', path, detail: embedded.join(', ') || 'текста нет' },
  );
  const hay = words(info.pageTexts.join('\n'));
  const lost = expectTexts.filter((t) => !inOrder(hay, words(t)));
  checks.push(
    info.pages === 0
      ? { code: 'render_complete', outcome: 'failed', path, detail: 'в PDF нет страниц' }
      : lost.length > 0
        ? { code: 'render_complete', outcome: 'failed', path, detail: `в отрисовке нет текста значений: ${lost.map((t) => `«${t.slice(0, 60)}»`).join('; ')}` }
        : { code: 'render_complete', outcome: 'passed', path, detail: `страниц: ${info.pages}` },
  );
  return { pdf, pages: info.pages, fonts: embedded };
};

const build = async (ctx: IJobContext, c: IReleaseCandidateRow, converter: IOfficeConverter): Promise<IBuilt> => {
  const inputs = await candidateInputs(ctx.pool, c.id);
  const ids = (kind: string) => inputs.filter((i) => i.kind === kind).sort((a, b) => a.ordinal - b.ordinal).map((i) => i.ref_id);
  const versions = (
    await ctx.pool.query<{ id: string; draft_id: string; field_key: string; value: FieldValue | null; state: string }>(
      'SELECT v.id, v.draft_id, f.field_key, v.value, v.state FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id WHERE v.id = ANY($1::uuid[])',
      [ids('field_version')],
    )
  ).rows;
  const calc = (
    await ctx.pool.query<{ source_grand_total: string | null; kp_total_rule: string | null }>(
      'SELECT cc.source_grand_total, cc.kp_total_rule FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id WHERE r.id = $1',
      [c.calculation_revision_id],
    )
  ).rows[0]!;
  // Отчёт ревизии пишется один раз и целиком в одной транзакции (этап 10): под арендой задания.
  const economics = await ctx.withLease((client) => ensureRevisionEconomics(client, c.calculation_revision_id, null));
  const calcValues: Record<string, string | null> = { source_grand_total: calc.source_grand_total, commercial_total: economics?.report.totals.commercial ?? null };
  const files: IFinishFile[] = [];
  const manifestFiles: IManifestFile[] = [];
  const checks: Check[] = [];
  let ordinal = 0;
  const add = (f: Omit<IFinishFile, 'ordinal'>, extra: Partial<IManifestFile> = {}): number => {
    ordinal += 1;
    files.push({ ...f, ordinal });
    manifestFiles.push({ path: f.path, role: f.role, audience: f.audience, mediaType: f.mediaType, sha256: f.sha256, size: f.size, ...extra });
    return ordinal;
  };

  for (const draftId of ids('application_draft')) {
    const d = (await getDraft(ctx.pool, draftId))!;
    const rev = (await getTemplateRevision(ctx.pool, d.template_revision_id))!;
    if (!rev.marked_sample_blob_sha256 || !rev.output_format || !rev.markup?.ok) throw new AssemblyFailure('markup_missing', `${d.title}: у ревизии шаблона нет проверенной разметки образца`);
    const schema = rev.field_schema as IFormSchema;
    const values = new Map<string, FieldValue | null>(versions.filter((v) => v.draft_id === d.id).map((v) => [v.field_key, v.state === 'cleared' ? null : v.value]));
    const format = rev.output_format;
    const data = renderData(schema, values, format);
    const marks = documentMarks(c.mode, d.is_demo);
    const sample = await readBlob(ctx, rev.marked_sample_blob_sha256);
    const numberKeys = new Set(allFields(schema).filter((f) => f.type === 'number').map((f) => f.key));
    let bytes: Buffer;
    let probe: Buffer;
    try {
      bytes = format === 'docx' ? renderDocx(sample, data, marks) : renderXlsx(sample, data, numberKeys, marks);
      probe = format === 'docx' ? renderDocx(sample, neutral(data), marks) : renderXlsx(sample, neutral(data), numberKeys, marks);
    } catch (err) {
      if (err instanceof OfficeError) throw new AssemblyFailure(err.code, `${d.title}: ${err.message}`);
      throw err;
    }
    const path = `${String(ordinal + 1).padStart(2, '0')} ${safeName(d.title)}.${format}`;
    if (detectFormat(bytes) !== format) throw new AssemblyFailure('render_failed', `${path}: результат — не ${format.toUpperCase()}`);
    const left = leftoverTags(probe, format);
    checks.push(left.length > 0 ? { code: 'placeholders_left', outcome: 'failed', path, detail: `остались теги разметки: ${left.slice(0, 20).join('; ')}` } : { code: 'placeholders_left', outcome: 'passed', path });
    if (format === 'xlsx') {
      const over = xlsxOverflow(bytes, sample);
      checks.push(over.length > 0 ? { code: 'cell_overflow', outcome: 'failed', path, detail: `текст не помещается в ячейки: ${over.join(', ')}` } : { code: 'cell_overflow', outcome: 'passed', path });
    }
    // Числа, связанные с расчётом (D-032 В-12-6): точное совпадение в единицах поля; неизвестное — «не сверено».
    for (const f of allFields(schema).filter((x): x is INumberField => x.type === 'number' && x.calc !== undefined)) {
      const v = values.get(f.key);
      if (v === null || v === undefined || data[f.key] === false) {
        checks.push({ code: 'numbers_match_calculation', outcome: 'not_applicable', path, detail: `«${f.label}»: значения нет` });
        continue;
      }
      const m = compareWithCalculation(f, typeof v === 'string' ? v : null, f.calc!.quantity, calcValues[f.calc!.quantity] ?? null);
      const title = CALC_QUANTITIES[f.calc!.quantity].title;
      checks.push(
        m.outcome === 'match'
          ? { code: 'numbers_match_calculation', outcome: 'passed', path, detail: `«${f.label}» = ${title}` }
          : m.outcome === 'mismatch'
            ? { code: 'numbers_match_calculation', outcome: 'failed', path, detail: `«${f.label}»: ${String(v)} ≠ ${m.expected} (${title} в единицах поля)` }
            : { code: 'numbers_match_calculation', outcome: 'unverified', path, detail: `«${f.label}»: ${m.reason}` },
      );
    }
    const stored = await storeBytes(ctx, bytes, MEDIA_TYPES[format]);
    const docOrdinal = add(
      { path, role: 'document', audience: rev.audience, mediaType: stored.mediaType, sha256: stored.sha256, size: stored.size, sourceOrdinal: null, templateRevisionId: rev.id, draftId: d.id, attachmentRevisionId: null, pages: null, fonts: null },
    );
    const preview = await previewOf(ctx, converter, bytes, format, path, checks, [...renderedTexts(data), ...marks]);
    const pv = await storeBytes(ctx, preview.pdf, MEDIA_TYPES.pdf);
    add(
      { path: `${path.replace(/\.[a-z]+$/u, '')} (превью).pdf`, role: 'preview', audience: 'internal', mediaType: pv.mediaType, sha256: pv.sha256, size: pv.size, sourceOrdinal: docOrdinal, templateRevisionId: null, draftId: null, attachmentRevisionId: null, pages: preview.pages, fonts: preview.fonts },
      { sourceSha256: stored.sha256, pages: preview.pages, fonts: preview.fonts },
    );
  }

  for (const revId of ids('attachment_revision')) {
    const a = (await getStandardAttachmentRevision(ctx.pool, revId))!;
    const bytes = await readBlob(ctx, a.blob_sha256);
    const format = detectFormat(bytes);
    if (!format) throw new AssemblyFailure('attachment_format', `${a.file_name}: формат вложения не поддерживается`);
    // Расширение — по формату содержимого, не по имени файла: PDF с именем «.docx» уходит как «.pdf».
    const path = `${String(ordinal + 1).padStart(2, '0')} ${safeName(a.file_name.replace(/\.[^.]+$/u, ''))}.${format}`;
    const docOrdinal = add({
      path, role: 'attachment', audience: a.audience, mediaType: a.media_type, sha256: a.blob_sha256, size: a.size_bytes, sourceOrdinal: null, templateRevisionId: null, draftId: null,
      attachmentRevisionId: a.id, pages: null, fonts: null,
    });
    const preview = await previewOf(ctx, converter, bytes, format, path, checks, []);
    const pv = format === 'pdf' ? { sha256: a.blob_sha256, size: a.size_bytes, mediaType: MEDIA_TYPES.pdf } : await storeBytes(ctx, preview.pdf, MEDIA_TYPES.pdf);
    add(
      { path: `${path.replace(/\.[a-z]+$/u, '')} (превью).pdf`, role: 'preview', audience: 'internal', mediaType: pv.mediaType, sha256: pv.sha256, size: pv.size, sourceOrdinal: docOrdinal, templateRevisionId: null, draftId: null, attachmentRevisionId: null, pages: preview.pages, fonts: preview.fonts },
      { sourceSha256: a.blob_sha256, pages: preview.pages, fonts: preview.fonts },
    );
  }
  return { files, manifestFiles, checks };
};

const manifestOf = async (ctx: IJobContext, c: IReleaseCandidateRow, converterVersion: string, built: IBuilt): Promise<IManifest> => {
  const inputs = await candidateInputs(ctx.pool, c.id);
  const ids = (kind: string) => inputs.filter((i) => i.kind === kind).sort((a, b) => a.ordinal - b.ordinal).map((i) => i.ref_id);
  const q = async <T extends object>(sql: string, params: unknown[]) => (await ctx.pool.query<T>(sql, params)).rows;
  const calc = (await q<{ id: string; kind: string; content_id: string; content_hash: string; kp_total_rule: string | null }>(
    'SELECT r.id, r.kind, r.content_id, cc.content_hash, cc.kp_total_rule FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id WHERE r.id = $1',
    [c.calculation_revision_id],
  ))[0]!;
  const scope = (await q<{ id: string; content_hash: string; source_set_revision_id: string }>('SELECT id, content_hash, source_set_revision_id FROM evidence_scope WHERE id = $1', [c.evidence_scope_id]))[0]!;
  const runs = await q<{ id: string; status: string; input_sha256: string | null }>(
    'SELECT r.id, r.status, i.input_sha256 FROM review_run r LEFT JOIN review_run_input i ON i.run_id = r.id WHERE r.id = ANY($1::uuid[]) ORDER BY r.created_at',
    [ids('review_run')],
  );
  const decisions = await q<{ id: string; decision_type: string }>('SELECT id, decision_type FROM decision WHERE id = ANY($1::uuid[]) ORDER BY created_at, id', [ids('decision')]);
  const templates = await q<{ id: string; template_id: string; seq: number; is_demo: boolean; schema_sha256: string; marked_sample_blob_sha256: string; output_format: string; audience: 'customer' | 'internal' }>(
    'SELECT r.id, r.template_id, r.seq, t.is_demo, r.schema_sha256, r.marked_sample_blob_sha256, r.output_format, r.audience FROM template_revision r JOIN application_template t ON t.id = r.template_id WHERE r.id = ANY($1::uuid[]) ORDER BY r.id',
    [ids('template_revision')],
  );
  const drafts = await q<{ id: string; title: string; template_revision_id: string }>('SELECT id, title, template_revision_id FROM application_draft WHERE id = ANY($1::uuid[])', [ids('application_draft')]);
  const versions = await q<{ id: string; draft_id: string; field_key: string; version: number }>(
    'SELECT v.id, v.draft_id, f.field_key, v.version FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id WHERE v.id = ANY($1::uuid[]) ORDER BY f.field_key',
    [ids('field_version')],
  );
  const attachments = await q<{ id: string; attachment_id: string; blob_sha256: string; media_type: string; audience: 'customer' | 'internal' }>(
    'SELECT id, attachment_id, blob_sha256, media_type, audience FROM standard_attachment_revision WHERE id = ANY($1::uuid[]) ORDER BY id',
    [ids('attachment_revision')],
  );
  const demo = templates.some((t) => t.is_demo);
  const notes = [
    ...(calc.kind === 'provisional' ? ['CALCULATION_PROVISIONAL: ревизия расчёта предварительная (блокер production этапа 13; X-01, Q-01)'] : []),
    ...(demo ? ['TEMPLATE_DEMO: в комплекте демонстрационные формы (блокер production этапа 13; Q-08)'] : []),
    ...(calc.kp_total_rule ? [] : ['KP_TOTAL_NOT_APPROVED: правило итога КП не утверждено (Q-05); сверка с итогом источника его не утверждает']),
    ...(built.checks.some((k) => k.outcome === 'unverified') ? ['NUMBERS_UNVERIFIED: часть чисел не сверена с расчётом'] : []),
  ];
  return {
    schema: MANIFEST_SCHEMA,
    candidate: { id: c.id, seq: c.seq, mode: c.mode, tenderId: c.tender_id, stageId: c.stage_id, createdAt: c.created_at.toISOString(), marks: documentMarks(c.mode, demo) },
    inputs: {
      calculationRevision: { id: calc.id, kind: calc.kind, contentId: calc.content_id, contentHash: calc.content_hash },
      evidenceScope: { id: scope.id, contentHash: scope.content_hash, sourceSetRevisionId: scope.source_set_revision_id },
      reviewRuns: runs.map((r) => ({ id: r.id, status: r.status, inputSha256: r.input_sha256 })),
      decisions: decisions.map((d) => ({ id: d.id, type: d.decision_type })),
      templates: templates.map((t) => ({ revisionId: t.id, templateId: t.template_id, seq: t.seq, isDemo: t.is_demo, schemaSha256: t.schema_sha256, markedSampleSha256: t.marked_sample_blob_sha256, outputFormat: t.output_format, audience: t.audience })),
      drafts: ids('application_draft').map((id) => {
        const d = drafts.find((x) => x.id === id)!;
        return { id, title: d.title, templateRevisionId: d.template_revision_id, fieldVersions: versions.filter((v) => v.draft_id === id).map((v) => ({ key: v.field_key, versionId: v.id, version: Number(v.version) })) };
      }),
      attachments: attachments.map((a) => ({ revisionId: a.id, attachmentId: a.attachment_id, sha256: a.blob_sha256, mediaType: a.media_type, audience: a.audience })),
      baselines: { calculation: Number(c.calculation_baseline_version), content: Number(c.content_baseline_version) },
      inputsSha256: c.inputs_sha256,
    },
    converter: { name: 'libreoffice', version: converterVersion },
    files: built.manifestFiles,
    checks: built.checks.map((k) => ({ code: k.code, outcome: k.outcome, ...(k.path ? { path: k.path } : {}), ...(k.detail ? { detail: k.detail } : {}) })),
    notes,
  };
};

const fail = (ctx: IJobContext, c: IReleaseCandidateRow, code: string, detail: string, converterVersion: string | null, checks: Check[] = []) =>
  ctx.complete((client) =>
    finishCandidate(client, { candidateId: c.id, converterVersion, files: [], checks: [...checks, { code, outcome: 'failed', detail }], manifest: null, failure: { code, detail } }).then(() => undefined),
  );

export const candidateAssembleHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const c = await getCandidate(ctx.pool, String(ctx.job.payload.candidateId));
    if (!c || c.status !== 'assembling') {
      await ctx.complete();
      return;
    }
    // Права создателя — текущие (D-032 В-12-7): участник с candidate.create, видит все закреплённые входы.
    const access = await loadAccessContext(ctx.pool, c.created_by, `candidate:${c.id}`);
    if (!access || !tenderCapabilities(access.roles, memberRoleOf(access, c.tender_id)).includes('candidate.create')) {
      return fail(ctx, c, 'creator_not_authorized', 'создатель кандидата больше не участник тендера с правом сборки', null);
    }
    const pinned = (await candidateInputs(ctx.pool, c.id)).filter((i) => i.kind === 'field_version').map((i) => i.ref_id);
    const visible = await fieldVersionVisibility(ctx.pool, access, pinned);
    if (pinned.some((id) => !visible(id))) return fail(ctx, c, 'restricted_inputs', 'создатель не видит все закреплённые значения полей: комплект не собирается', null);
    const converter = createOfficeConverter(ctx.config.office);
    if (!converter) return fail(ctx, c, 'converter_unavailable', 'LibreOffice (soffice) не найден: превью не построить, комплект не собирается (D-032 В-12-2)', null);
    let version: string;
    try {
      version = await converter.version();
    } catch (err) {
      return fail(ctx, c, 'converter_unavailable', (err as Error).message, null);
    }
    let built: IBuilt;
    try {
      built = await build(ctx, c, converter);
    } catch (err) {
      if (err instanceof AssemblyFailure) return fail(ctx, c, err.code, err.message, version);
      throw err;
    }
    const failed = built.checks.filter((k) => k.outcome === 'failed');
    if (failed.length > 0) {
      const detail = failed.map((k) => `${k.code}${k.path ? ` (${k.path})` : ''}: ${k.detail ?? ''}`).join('; ').slice(0, 4000);
      await ctx.complete((client) =>
        finishCandidate(client, { candidateId: c.id, converterVersion: version, files: [], checks: built.checks, manifest: null, failure: { code: failed[0]!.code, detail } }).then(() => undefined),
      );
      return;
    }
    // Хэши файлов пересчитываются из хранилища перед манифестом (ADR-003 §7).
    const broken: string[] = [];
    for (const f of built.files) if (!(await ctx.store.verify(f.sha256))) broken.push(f.path);
    built.checks.push(broken.length > 0 ? { code: 'hashes', outcome: 'failed', detail: `SHA-256 не совпадает: ${broken.join(', ')}` } : { code: 'hashes', outcome: 'passed', detail: `файлов: ${built.files.length}` });
    if (broken.length > 0) return fail(ctx, c, 'hashes', `SHA-256 файлов не совпадает с хранилищем: ${broken.join(', ')}`, version, built.checks);
    const manifest = await manifestOf(ctx, c, version, built);
    const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
    const stored = await storeBytes(ctx, bytes, 'application/json');
    const blobs = new Map<string, { size: number; mediaType: string; storageKey: string | null }>();
    await ctx.complete(async (client) => {
      await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.size, mediaType: 'application/json', storageKey: stored.storageKey });
      for (const f of built.files) {
        if (blobs.has(f.sha256)) continue;
        blobs.set(f.sha256, { size: f.size, mediaType: f.mediaType, storageKey: null });
        const exists = await client.query('SELECT 1 FROM blob WHERE sha256 = $1', [f.sha256]);
        if (!exists.rowCount) await insertBlob(client, { sha256: f.sha256, sizeBytes: f.size, mediaType: f.mediaType, storageKey: storageKeyOf(f.sha256) });
      }
      await finishCandidate(client, { candidateId: c.id, converterVersion: version, files: built.files, checks: built.checks, manifest: { blobSha256: stored.sha256, sha256: stored.sha256, body: manifest }, failure: null });
    });
  },
  onTerminalFailure: async (client, ctx, failure) => {
    const c = await getCandidate(client, String(ctx.job.payload.candidateId));
    if (!c || c.status !== 'assembling') return;
    await finishCandidate(client, { candidateId: c.id, converterVersion: null, files: [], checks: [], manifest: null, failure: { code: 'assembly_error', detail: `${failure.code}: ${failure.message}`.slice(0, 4000) } });
  },
};
