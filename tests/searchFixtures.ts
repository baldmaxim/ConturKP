// Фикстуры поиска (этап 05): документы загружаются штатным импортом, прогоны распознавания с
// заданным текстом страниц создаются через слой данных по настоящей машине состояний прогона
// (queued → running → complete) — триггеры этапа 04 проверяются заодно. Текст синтетический.
import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { IModelGatewayEmbeddings } from '../packages/adapters/src/index.ts';
import type { IAppConfig } from '../packages/config/src/index.ts';
import {
  finishRun,
  getActiveVersion,
  insertFragments,
  insertPages,
  versionCompleteness,
  type FragmentKind,
  type FragmentOrigin,
  type INewFragment,
  type Pool,
} from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { drain, idem, makeWorker, type ITestDb, type TestClient } from './helpers.ts';
import { fakePdf } from './zip.ts';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

export interface IBlockSpec {
  text: string;
  origin?: FragmentOrigin;
  kind?: FragmentKind;
}

export interface IPageSpec {
  stamp?: string;
  blocks: (string | IBlockSpec)[];
}

export interface IRunSpec {
  pages: IPageSpec[];
  // Фрагменты без страницы (секции без блока, R04-10).
  unpaged?: string[];
}

// Загрузка файла штатным импортом (этап 03): редакция документа в тендере этапа.
export const uploadDocument = async (db: ITestDb, config: IAppConfig, client: TestClient, stageId: string, name: string): Promise<string> => {
  const r = await client.post(`/stages/${stageId}/imports?name=${encodeURIComponent(name)}`, fakePdf(`${name}-${randomBytes(4).toString('hex')}`), {
    headers: { 'Content-Type': 'application/octet-stream', ...idem() },
  });
  expect(r.status, r.text).toBe(202);
  await drain(makeWorker(db, config));
  const batch = await client.get(`/imports/${r.body.id}`);
  const revisionId = batch.body.items[0]?.documentRevisionId as string | undefined;
  expect(revisionId, JSON.stringify(batch.body)).toBeTruthy();
  return revisionId!;
};

// Прогон распознавания с заданным текстом: новый прогон встаёт за хвостом истории редакции.
// Владелец прогона — владелец редакции (тендер или договор, D-023): фикстура берёт его из редакции.
export const seedEvidenceRun = async (pool: Pool, revisionId: string, spec: IRunSpec): Promise<string> => {
  const rev = await pool.query<{ tender_id: string | null; contract_id: string | null }>('SELECT tender_id, contract_id FROM document_revision WHERE id = $1', [
    revisionId,
  ]);
  const { tender_id: tenderId, contract_id: contractId } = rev.rows[0]!;
  const artifact = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [artifact, `seed/${artifact}`]);
  const run = await pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, contract_id, engine, source_artifact_sha256, source_artifact_name, supersedes_run_id)
     VALUES ($1, $2, $4, 'rdweb_export', $3, 'seed.zip', (SELECT p.id FROM recognition_run p
       WHERE p.document_revision_id = $1 AND p.status IN ('complete', 'partial')
         AND NOT EXISTS (SELECT 1 FROM recognition_run c WHERE c.supersedes_run_id = p.id AND c.status NOT IN ('failed', 'cancelled'))
       ORDER BY p.created_at DESC LIMIT 1)) RETURNING id`,
    [revisionId, tenderId, artifact, contractId],
  );
  const runId = run.rows[0]!.id;
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [runId]);
  await insertPages(
    pool,
    runId,
    spec.pages.map((_, i) => ({ pageIndex: i, pageLabel: String(i + 1), sheetLabel: null, widthPx: 2480, heightPx: 3508, rotation: 0, status: 'recognized' as const })),
  );
  const fragments: INewFragment[] = [];
  const base = (pageIndex: number | null, key: string, ordinal: number, text: string): INewFragment => ({
    origin: 'recognized_text',
    fragmentKind: 'text_block',
    fragmentKey: key,
    externalBlockId: null,
    ordinal,
    pageIndex,
    bboxNorm: pageIndex === null ? null : [0.1, 0.1 + ordinal * 0.05, 0.9, 0.14 + ordinal * 0.05],
    bboxSpace: pageIndex === null ? null : 'page_rotated',
    shapeType: pageIndex === null ? null : 'rectangle',
    polygonNorm: null,
    rotation: pageIndex === null ? null : 0,
    text,
    textSha256: sha(text),
    derivedModelRef: null,
    externalCropUrl: null,
    warnings: [],
    partIndex: 0,
    partTotal: 1,
  });
  spec.pages.forEach((page, p) => {
    if (page.stamp) fragments.push({ ...base(p, `stamp:p${p}:0`, 0, page.stamp), fragmentKind: 'stamp_block' });
    page.blocks.forEach((b, i) => {
      const block = typeof b === 'string' ? { text: b } : b;
      const f = base(p, `block:p${p}:${i}`, i + 1, block.text);
      f.origin = block.origin ?? 'recognized_text';
      f.fragmentKind = block.kind ?? (f.origin === 'model_description' ? 'summary' : 'text_block');
      if (f.origin === 'model_description') f.derivedModelRef = 'rdweb_export:summary';
      fragments.push(f);
    });
  });
  (spec.unpaged ?? []).forEach((text, i) => fragments.push({ ...base(null, `md:px:${i}:text`, i, text), fragmentKind: 'unknown_block' }));
  await insertFragments(pool, { runId, tenderId, contractId, documentRevisionId: revisionId }, fragments);
  const ok = await finishRun(pool, runId, {
    status: 'complete',
    engineSchemaVersion: '1',
    pagesTotal: spec.pages.length,
    pagesRecognized: spec.pages.length,
    quality: {},
  });
  expect(ok).toBe(true);
  return runId;
};

export const fragmentIdOf = async (pool: Pool, runId: string, text: string): Promise<string> => {
  const r = await pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1 AND text = $2', [runId, text]);
  expect(r.rows, `фрагмент «${text}»`).toHaveLength(1);
  return r.rows[0]!.id;
};

// Рабочий состав этапа: черновик с включёнными редакциями; по желанию — заморозка.
export const setWorkingSet = async (client: TestClient, stageId: string, revisionIds: string[], freeze = false): Promise<string> => {
  const sets = (await client.get(`/stages/${stageId}/source-sets`)).body.items as { revisions: { id: string; status: string; rowVersion: number }[] }[];
  const open = sets[0]?.revisions.find((r) => r.status === 'draft') ?? null;
  let id: string;
  let etag: string;
  if (open) {
    id = open.id;
    etag = `"${open.id}:${open.rowVersion}"`;
  } else {
    const d = await client.post(`/stages/${stageId}/source-set-revisions`, {}, { headers: idem() });
    expect(d.status, d.text).toBe(201);
    id = d.body.id;
    etag = d.headers.etag as string;
  }
  const put = await client.put(
    `/source-set-revisions/${id}/items`,
    { items: revisionIds.map((documentRevisionId) => ({ documentRevisionId, inclusion: 'included' })) },
    { headers: { 'If-Match': etag } },
  );
  expect(put.status, put.text).toBe(200);
  if (freeze) {
    const f = await client.post(`/source-set-revisions/${id}/freeze`, {}, { headers: { 'If-Match': put.headers.etag as string, ...idem() } });
    expect(f.status, f.text).toBe(200);
  }
  return id;
};

export const fixScope = async (client: TestClient, stageId: string): Promise<string> => {
  const r = await client.post(`/stages/${stageId}/evidence-scopes`, {}, { headers: idem() });
  expect([200, 201], r.text).toContain(r.status);
  return r.body.id as string;
};

// Индекс доводится до полноты: проход обслуживания создаёт версию и ставит пачки, worker их
// выполняет, следующий проход активирует. Возвращает активную версию.
export const buildIndex = async (db: ITestDb, worker: WorkerRuntime): Promise<string> => {
  for (let i = 0; i < 20; i += 1) {
    await worker.maintain({ checkModel: true });
    await drain(worker);
    const active = await getActiveVersion(db.pool);
    const building = await db.pool.query("SELECT 1 FROM search_index_version WHERE status = 'building'");
    if (active && (building.rowCount ?? 0) === 0) {
      const c = await versionCompleteness(db.pool, active);
      if (c.missingUnits === 0 && c.missingVectors === 0) return active.id;
    }
  }
  throw new Error('индекс не достиг полноты');
};

export const searchBody = (tenderId: string, stageId: string, query: string, limit = 10) => ({
  context: { kind: 'tender', tenderId, mode: 'working', stageId },
  query,
  limit,
});

export const reviewBody = (tenderId: string, evidenceScopeId: string, query: string, limit = 10) => ({
  context: { kind: 'tender', tenderId, mode: 'review', evidenceScopeId },
  query,
  limit,
});

// Перенос файла донора: раздел «##» (или «## OCR page N») — страница, «#» — шапка листа,
// абзац — фрагмент распознанного текста. Преамбула до первого раздела — отдельная страница.
export const markdownToRun = (md: string): IRunSpec => {
  const lines = md.split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) ?? '').slice(2).trim();
  const pages: IRunSpec['pages'] = [];
  let blocks: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push(paragraph.join(' ').trim());
    paragraph = [];
  };
  const flushPage = () => {
    flushParagraph();
    if (blocks.length > 0) pages.push({ stamp: title, blocks });
    blocks = [];
  };
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    if (line.startsWith('## ')) {
      flushPage();
      if (!/^## OCR page \d+/u.test(line)) blocks.push(line.slice(3).trim());
      continue;
    }
    if (line.trim() === '') flushParagraph();
    else paragraph.push(line.trim());
  }
  flushPage();
  return { pages };
};

export type { IModelGatewayEmbeddings };
