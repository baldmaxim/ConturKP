// Регрессии по ревью 04-2 (docs/reviews/04-review-2.md): R04-07…R04-12.
// Каждая проверка падает на коде передачи `8c3f7b7` и описывает требуемое поведение.
//
// R04-07 — курсор выдачи фрагментов обязан проходить собственную проверку контракта.
// R04-08 — metadata обязана принадлежать комплекту того PDF, что совпал по SHA-256.
// R04-09 — координаты доказательства не «подправляются» обрезкой.
// R04-10 — страницы прогона обязаны образовывать точный набор, ссылки на них — существовать.
// R04-11 — предел числа страниц считается по оригиналу, а не по перечню в экспорте.
// R04-12 — история прогонов редакции линейна.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildRdwebExport } from './rdweb.ts';
import { buildZip, fakePdf, type IZipEntry } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let worker: ReturnType<typeof makeWorker>;

const config = testConfig();
const octet = { 'Content-Type': 'application/octet-stream' };

const registerPdf = async (name: string, pdf: Buffer): Promise<string> => {
  const up = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent(name)}`, pdf, { headers: { ...octet, ...idem() } });
  expect(up.status, up.text).toBe(202);
  await drain(worker);
  return (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
};

const postExport = (revisionId: string, zip: Buffer, name = 'export.zip') =>
  s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=${encodeURIComponent(name)}`, zip, { headers: { ...octet, ...idem() } });

const runOf = async (runId: string) => (await s.eng1.get(`/recognition-runs/${runId}`)).body;

const importZip = async (revisionId: string, zip: Buffer) => {
  const accepted = await postExport(revisionId, zip);
  expect(accepted.status, accepted.text).toBe(202);
  await drain(worker);
  return runOf(accepted.body.id);
};

const members = (fx: ReturnType<typeof buildRdwebExport>, docName: string): { pdf: IZipEntry; blocks: IZipEntry; md: IZipEntry } => ({
  pdf: { name: `${docName}.pdf`, data: fx.pdf },
  blocks: { name: `${docName}_blocks.json`, data: Buffer.from(fx.blocksJson, 'utf8') },
  md: { name: `${docName}_results.md`, data: Buffer.from(fx.resultsMd, 'utf8') },
});

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => db.drop());

describe('R04-07: выдача фрагментов страницами', () => {
  it('курсор сервера проходит проверку контракта и продолжает выдачу без пропусков и повторов', async () => {
    const fx = buildRdwebExport({ docName: 'Много-фрагментов', extraTextBlocks: 210 });
    const revisionId = await registerPdf('Много-фрагментов.pdf', fx.pdf);
    const run = await importZip(revisionId, fx.zip);
    expect(run.status).toBe('complete');

    const first = await s.eng1.get(`/recognition-runs/${run.id}/fragments?pageIndex=0`);
    expect(first.status, first.text).toBe(200);
    expect(first.body.items.length).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();

    // Курсор выдал сам сервер: он обязан пройти проверку query-контракта на следующем запросе.
    const second = await s.eng1.get(`/recognition-runs/${run.id}/fragments?pageIndex=0&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status, second.text).toBe(200);
    expect(second.body.items.length).toBeGreaterThan(0);

    const firstIds = (first.body.items as { id: string }[]).map((f) => f.id);
    const secondIds = (second.body.items as { id: string }[]).map((f) => f.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    // Обход маленькими порциями собирает ровно тот же набор: ни пропусков, ни дублей.
    const all: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const url = `/recognition-runs/${run.id}/fragments?pageIndex=0&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await s.eng1.get(url);
      expect(page.status, page.text).toBe(200);
      all.push(...(page.body.items as { id: string }[]).map((f) => f.id));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(firstIds.length + secondIds.length);
    expect(new Set(all)).toEqual(new Set([...firstIds, ...secondIds]));
  });
});

describe('R04-08: metadata принадлежит комплекту своего PDF', () => {
  it('PDF одного документа с распознаванием другого не принимается', async () => {
    const a = buildRdwebExport({ docName: 'Комплект-А' });
    const b = buildRdwebExport({ docName: 'Комплект-Б' });
    const revisionId = await registerPdf('Комплект-А.pdf', a.pdf);

    const mixed = buildZip([members(a, 'Комплект-А').pdf, members(b, 'Комплект-Б').blocks, members(b, 'Комплект-Б').md]);
    const run = await importZip(revisionId, mixed);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('export_group_mismatch');
  });

  it('частично смешанный комплект тоже отклоняется', async () => {
    const a = buildRdwebExport({ docName: 'Частично-А' });
    const b = buildRdwebExport({ docName: 'Частично-Б' });
    const revisionId = await registerPdf('Частично-А.pdf', a.pdf);

    const mixed = buildZip([members(a, 'Частично-А').pdf, members(a, 'Частично-А').blocks, members(b, 'Частично-Б').md]);
    const run = await importZip(revisionId, mixed);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('export_group_mismatch');
  });

  it('из архива с двумя полными комплектами берётся тот, чей PDF совпал по SHA-256', async () => {
    const a = buildRdwebExport({ docName: 'Полный-А' });
    const b = buildRdwebExport({ docName: 'Полный-Б' });
    const revisionId = await registerPdf('Полный-А.pdf', a.pdf);

    const both = buildZip([
      members(b, 'Полный-Б').pdf,
      members(b, 'Полный-Б').blocks,
      members(b, 'Полный-Б').md,
      members(a, 'Полный-А').pdf,
      members(a, 'Полный-А').blocks,
      members(a, 'Полный-А').md,
    ]);
    const run = await importZip(revisionId, both);
    expect(run.status).toBe('complete');
    expect(run.quality.documentName).toBe('Полный-А');
  });
});

describe('R04-09: координаты доказательства не подправляются', () => {
  it('координаты вне диапазона не дают ложной рамки', async () => {
    const fx = buildRdwebExport({ docName: 'Кривые-координаты', outOfRangeCoords: true, polygonPages: [0] });
    const revisionId = await registerPdf('Кривые-координаты.pdf', fx.pdf);
    const run = await importZip(revisionId, fx.zip);
    expect(run.status).toBe('complete');

    const page = await s.eng1.get(`/recognition-runs/${run.id}/fragments?pageIndex=0`);
    const items = page.body.items as { bboxNorm: number[] | null; polygonNorm: number[] | null; warnings: string[] }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((f) => f.bboxNorm === null)).toBe(true);
    expect(items.every((f) => f.polygonNorm === null)).toBe(true);
    expect((run.quality.warnings as { code: string }[]).map((w) => w.code)).toContain('coords_out_of_range');
  });
});

describe('R04-10: страницы прогона и ссылки на них', () => {
  it('набор номеров страниц обязан быть точным: одна страница с номером 999 не завершает прогон', async () => {
    const revisionId = await registerPdf('Номера-страниц.pdf', fakePdf('номера'));
    const rev = await db.pool.query<{ tender_id: string }>('SELECT tender_id FROM document_revision WHERE id = $1', [revisionId]);
    const sha = '9'.repeat(64);
    await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `r04c/${sha}`]);
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id)
       VALUES ($1, $2, 'rdweb_export', $3, (SELECT p.id FROM recognition_run p
       WHERE p.document_revision_id = $1 AND p.status IN ('complete', 'partial')
         AND NOT EXISTS (SELECT 1 FROM recognition_run c WHERE c.supersedes_run_id = p.id AND c.status NOT IN ('failed', 'cancelled'))
       ORDER BY p.created_at DESC LIMIT 1)) RETURNING id`,
      [revisionId, rev.rows[0]!.tender_id, sha],
    );
    const runId = run.rows[0]!.id;
    await db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [runId]);
    await db.pool.query(
      "INSERT INTO recognition_page (run_id, page_index, width_px, height_px, status) VALUES ($1, 999, 100, 200, 'recognized')",
      [runId],
    );
    await expect(
      db.pool.query(
        `UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1,
                finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/не образуют набор 0\.\./);

    // Ссылка доказательства на несуществующую страницу прогона отклоняется внешним ключом.
    await expect(
      db.pool.query(
        `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id,
           origin, fragment_kind, fragment_key, page_index, text, text_sha256)
         VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'p5', 5, 'x', $4)`,
        [rev.rows[0]!.tender_id, runId, revisionId, '0'.repeat(64)],
      ),
    ).rejects.toThrow(/evidence_fragment_page_fk|violates foreign key/i);
  });

  it('блок за пределами оригинала не создаёт ссылку на несуществующую страницу', async () => {
    const fx = buildRdwebExport({ docName: 'Лишняя-страница', pages: 4, outOfRangePageBlocks: [7] });
    const revisionId = await registerPdf('Лишняя-страница.pdf', fx.pdf);
    const run = await importZip(revisionId, fx.zip);
    expect(run.status).toBe('complete');
    expect(run.pagesTotal).toBe(4);
    expect((run.quality.warnings as { code: string }[]).map((w) => w.code)).toContain('page_index_out_of_range');

    const orphan = await db.pool.query<{ page_index: number | null; warnings: string[] }>(
      "SELECT page_index, warnings FROM evidence_fragment WHERE run_id = $1 AND external_block_id = 'blk-7-oor'",
      [run.id],
    );
    expect(orphan.rowCount).toBe(1);
    expect(orphan.rows[0]!.page_index).toBeNull();
    expect(orphan.rows[0]!.warnings).toContain('page_index_out_of_range');
  });
});

describe('R04-11: предел числа страниц считается по оригиналу', () => {
  it('оригинал со страницами сверх предела отклоняется до создания страниц прогона', async () => {
    const tight = testConfig({
      storageRoot: config.storageRoot,
      recognition: { ...config.recognition, maxPages: 2 },
    });
    const fx = buildRdwebExport({ docName: 'Сверх-предела', pages: 4 });
    const revisionId = await registerPdf('Сверх-предела.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    await drain(makeWorker(db, tight, 'pages-worker'));

    const run = await runOf(accepted.body.id);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    expect(run.failureDetail).toMatch(/в оригинале 4 страниц, предел разбора — 2/);
    expect(run.pages).toEqual([]);
    const pages = await db.pool.query('SELECT 1 FROM recognition_page WHERE run_id = $1', [run.id]);
    expect(pages.rowCount).toBe(0);
  });
});

describe('R04-12: история прогонов редакции линейна', () => {
  it('второй архив до завершения первого отклоняется, а не создаёт брата с общим предшественником', async () => {
    const first = buildRdwebExport({ docName: 'Линейность', generatedAt: '2026-09-20T10:00:00Z' });
    const second = buildRdwebExport({ docName: 'Линейность', generatedAt: '2026-09-21T10:00:00Z' });
    const revisionId = await registerPdf('Линейность.pdf', first.pdf);

    const accepted = await postExport(revisionId, first.zip);
    expect(accepted.status, accepted.text).toBe(202);
    const conflict = await postExport(revisionId, second.zip);
    expect(conflict.status, conflict.text).toBe(409);
    expect(conflict.body.code).toBe('STATE_CONFLICT');

    const active = await db.pool.query('SELECT 1 FROM recognition_run WHERE document_revision_id = $1 AND status IN (\'queued\', \'running\')', [revisionId]);
    expect(active.rowCount).toBe(1);

    // После завершения первого прогона второй архив принимается и встаёт за ним цепочкой.
    await drain(worker);
    const next = await postExport(revisionId, second.zip);
    expect(next.status, next.text).toBe(202);
    expect(next.body.supersedesRunId).toBe(accepted.body.id);

    const children = await db.pool.query('SELECT count(*)::int AS n FROM recognition_run WHERE supersedes_run_id = $1', [accepted.body.id]);
    expect(children.rows[0]!.n).toBe(1);
  });
});
