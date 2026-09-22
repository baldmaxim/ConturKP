// Регрессии по ревью 04-3 (docs/reviews/04-review-3.md): R04-08, R04-12, R04-16, R04-17.
// Каждая проверка падает на коде передачи `8075c00`.
//
// R04-08 — неоднозначный комплект экспорта обязан отклоняться, а не выбираться эвристикой.
// R04-12 — линейность истории держится второй линией БД, а не только дисциплиной API.
// R04-16 — похожий, но недопустимый курсор обязан давать 400, а не 500 на касте в SQL.
// R04-17 — подпись предупреждения о координатах соответствует поведению.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

const importZip = async (revisionId: string, zip: Buffer) => {
  const accepted = await s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, zip, {
    headers: { ...octet, ...idem() },
  });
  expect(accepted.status, accepted.text).toBe(202);
  await drain(worker);
  return (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
};

const members = (fx: ReturnType<typeof buildRdwebExport>, docName: string): { pdf: IZipEntry; blocks: IZipEntry; md: IZipEntry } => ({
  pdf: { name: `${docName}.pdf`, data: fx.pdf },
  blocks: { name: `${docName}_blocks.json`, data: Buffer.from(fx.blocksJson, 'utf8') },
  md: { name: `${docName}_results.md`, data: Buffer.from(fx.resultsMd, 'utf8') },
});

// ---- прямые операции под ролью приложения: вторая линия БД

const newBlob = async (): Promise<string> => {
  const sha = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `r04d/${sha}`]);
  return sha;
};

const insertRun = async (revisionId: string, tenderId: string, supersedes: string | null): Promise<string> => {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id)
     VALUES ($1, $2, 'rdweb_export', $3, $4) RETURNING id`,
    [revisionId, tenderId, await newBlob(), supersedes],
  );
  return r.rows[0]!.id;
};

const completeRun = async (runId: string): Promise<void> => {
  await db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [runId]);
  await db.pool.query("INSERT INTO recognition_page (run_id, page_index, width_px, height_px, status) VALUES ($1, 0, 100, 200, 'recognized')", [runId]);
  await db.pool.query(
    `UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1,
            finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [runId],
  );
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => db.drop());

describe('R04-08: неоднозначный комплект экспорта отклоняется', () => {
  it('две metadata одной роли в комплекте — отказ, а не выбор по имени', async () => {
    const a = buildRdwebExport({ docName: 'Неоднозначный' });
    const revisionId = await registerPdf('Неоднозначный.pdf', a.pdf);
    const m = members(a, 'Неоднозначный');
    // `Неоднозначный.json` попадает в тот же комплект, что и `Неоднозначный_blocks.json`.
    const zip = buildZip([m.pdf, m.blocks, { name: 'Неоднозначный.json', data: Buffer.from(a.blocksJson, 'utf8') }, m.md]);

    const run = await importZip(revisionId, zip);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('export_group_ambiguous');
    expect(run.failureDetail).toMatch(/несколько файлов роли _blocks\.json/);
  });

  it('два одинаковых PDF в разных комплектах — отказ, а не выбор по порядку членов архива', async () => {
    const a = buildRdwebExport({ docName: 'Копия-А' });
    const b = buildRdwebExport({ docName: 'Копия-Б' });
    const revisionId = await registerPdf('Копия-А.pdf', a.pdf);
    const ma = members(a, 'Копия-А');
    const mb = members(b, 'Копия-Б');
    // В комплекте Б лежит тот же PDF: по SHA-256 с редакцией совпадают оба.
    const zip = buildZip([ma.pdf, ma.blocks, ma.md, { name: 'Копия-Б.pdf', data: a.pdf }, mb.blocks, mb.md]);

    const run = await importZip(revisionId, zip);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('export_group_ambiguous');
    expect(run.failureDetail).toMatch(/совпало несколько PDF/);
  });

  it('однозначный комплект по-прежнему принимается', async () => {
    const a = buildRdwebExport({ docName: 'Однозначный' });
    const revisionId = await registerPdf('Однозначный.pdf', a.pdf);
    const m = members(a, 'Однозначный');
    const run = await importZip(revisionId, buildZip([m.pdf, m.blocks, m.md]));
    expect(run.status).toBe('complete');
  });
});

describe('R04-12: линейность истории держится базой данных', () => {
  it('второе ответвление от того же предшественника отклоняется', async () => {
    const revisionId = await registerPdf('Цепочка.pdf', fakePdf('цепочка'));
    const rev = await db.pool.query<{ tender_id: string }>('SELECT tender_id FROM document_revision WHERE id = $1', [revisionId]);
    const tenderId = rev.rows[0]!.tender_id;

    const a = await insertRun(revisionId, tenderId, null);
    await completeRun(a);
    const b = await insertRun(revisionId, tenderId, a);
    await completeRun(b);

    // A уже перекрыт прогоном B: второй потомок того же предка — ветвление.
    await expect(insertRun(revisionId, tenderId, a)).rejects.toThrow(/предшественник уже перекрыт|recognition_run_supersedes_key/i);
  });

  it('второй корень истории отклоняется', async () => {
    const revisionId = await registerPdf('Второй-корень.pdf', fakePdf('корень'));
    const rev = await db.pool.query<{ tender_id: string }>('SELECT tender_id FROM document_revision WHERE id = $1', [revisionId]);
    const tenderId = rev.rows[0]!.tender_id;

    const a = await insertRun(revisionId, tenderId, null);
    await completeRun(a);
    await expect(insertRun(revisionId, tenderId, null)).rejects.toThrow(/уже есть история распознавания/);
  });

  it('штатная цепочка A → B → C проходит, а отказавшая попытка её не закрывает', async () => {
    const revisionId = await registerPdf('Штатная-цепочка.pdf', fakePdf('штатная'));
    const rev = await db.pool.query<{ tender_id: string }>('SELECT tender_id FROM document_revision WHERE id = $1', [revisionId]);
    const tenderId = rev.rows[0]!.tender_id;

    const a = await insertRun(revisionId, tenderId, null);
    await completeRun(a);
    const b = await insertRun(revisionId, tenderId, a);
    await completeRun(b);
    const c = await insertRun(revisionId, tenderId, b);
    await completeRun(c);
    const chain = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM recognition_run WHERE document_revision_id = $1 AND status = 'complete'",
      [revisionId],
    );
    expect(chain.rows[0]!.n).toBe(3);

    // Отказавшая попытка места потомка не занимает: следующая встаёт за тем же хвостом.
    const failed = await insertRun(revisionId, tenderId, c);
    await db.pool.query(
      "UPDATE recognition_run SET status = 'failed', failure_code = 'test', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [failed],
    );
    await expect(insertRun(revisionId, tenderId, c)).resolves.toBeTruthy();
  });
});

describe('R04-16: недопустимый курсор не доходит до SQL', () => {
  it('похожая, но не UUID строка даёт 400, а не 500', async () => {
    const fx = buildRdwebExport({ docName: 'Курсор' });
    const revisionId = await registerPdf('Курсор.pdf', fx.pdf);
    const run = await importZip(revisionId, fx.zip);
    expect(run.status).toBe('complete');

    const bad = `0:0:0:${'-'.repeat(36)}`;
    const r = await s.eng1.get(`/recognition-runs/${run.id}/fragments?cursor=${encodeURIComponent(bad)}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');

    // Курсор самого сервера по-прежнему принимается.
    const first = await s.eng1.get(`/recognition-runs/${run.id}/fragments?pageIndex=0&limit=1`);
    expect(first.status).toBe(200);
    const next = await s.eng1.get(`/recognition-runs/${run.id}/fragments?pageIndex=0&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(next.status, next.text).toBe(200);
  });
});

// Подписи интерфейса собираются сборщиком веба, поэтому проверяются по исходному тексту:
// импорт модуля затянул бы в корневой tsconfig весь граф веб-приложения.
describe('R04-17: подпись предупреждения соответствует поведению', () => {
  it('координаты вне диапазона не называются усечёнными', () => {
    const labels = readFileSync('apps/web/src/utils/sourceLabels.ts', 'utf8');
    const line = labels.split(/\r?\n/).find((l) => l.includes('coords_out_of_range:'));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/усечен/i);
    expect(line).toMatch(/выделение не показано/i);
  });
});
