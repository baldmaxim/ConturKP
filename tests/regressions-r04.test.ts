// Регрессии по ревью 04-1 (docs/reviews/04-review-1.md): R04-01, R04-02, R04-03.
// Каждая проверка падает на коде передачи `de90029` и описывает поведение, которого
// требует ревью, а не то, которое было.
//
// R04-01 — импорт RDWeb обязан проходить тот же ресурсный контур ZIP, что и обычный импорт.
// R04-02 — отмена задания обязана терминализовать прогон и не оставлять его активным без job.
// R04-03 — полнота меряется по фактическому числу страниц оригинала, а не по составу экспорта.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockingFreezeItems, claimJob, getJob, lockOwnedJob, recoverExpiredJobs, requestCancel, startRun } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildRdwebExport } from './rdweb.ts';
import { buildZip, fakePdf, type IZipEntry } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let worker: ReturnType<typeof makeWorker>;
let tightWorker: ReturnType<typeof makeWorker>;

const config = testConfig();

// Тесный ресурсный контур: те же ключи, что у обычного импорта, но малые значения —
// иначе для проверки лимитов пришлось бы собирать гигабайтные архивы.
// Хранилище общее с основной конфигурацией: иначе worker не увидит ни архив, ни оригинал.
const tight = testConfig({
  storageRoot: config.storageRoot,
  limits: { maxUploadBytes: 64 * 1024 * 1024, maxEntryBytes: 4096, maxArchiveTotalBytes: 16384, maxArchiveEntries: 6, maxCompressionRatio: 20 },
  recognition: { maxMetadataBytes: 4000, maxMetadataTotalBytes: 6000, maxTotalTextChars: 4 * 1024 * 1024, maxPdfBytes: 16 * 1024 * 1024, maxPages: 10_000 },
});

const octet = { 'Content-Type': 'application/octet-stream' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const registerPdf = async (name: string, pdf: Buffer): Promise<string> => {
  const up = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent(name)}`, pdf, { headers: { ...octet, ...idem() } });
  expect(up.status, up.text).toBe(202);
  await drain(worker);
  return (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
};

const postExport = (revisionId: string, zip: Buffer, name = 'export.zip') =>
  s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=${encodeURIComponent(name)}`, zip, { headers: { ...octet, ...idem() } });

const runOf = async (runId: string) => (await s.eng1.get(`/recognition-runs/${runId}`)).body;

const jobOfRun = async (runId: string): Promise<string> =>
  (await db.pool.query<{ id: string }>("SELECT id FROM job WHERE kind = 'recognition.import' AND payload->>'runId' = $1", [runId])).rows[0]!.id;

// Импорт архива, который обязан быть отклонён ресурсным контуром: разбор до адаптера не доходит.
const importRejected = async (revisionId: string, entries: IZipEntry[]) => {
  const accepted = await postExport(revisionId, buildZip(entries));
  expect(accepted.status, accepted.text).toBe(202);
  await drain(tightWorker);
  return runOf(accepted.body.id);
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
  tightWorker = makeWorker(db, tight, 'tight-worker');
});
afterAll(async () => db.drop());

describe('R04-01: ресурсный контур архива распознавания', () => {
  let revisionId: string;

  beforeAll(async () => {
    revisionId = await registerPdf('Лимиты.pdf', fakePdf('лимиты'));
  });

  it('PDF с заявленным размером сверх лимита элемента не открывается и не хешируется', async () => {
    const run = await importRejected(revisionId, [
      { name: 'большой.pdf', data: Buffer.alloc(5000, 0x41) },
      { name: 'x_blocks.json', data: Buffer.from('{}') },
    ]);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    // Сообщение возникает до entry.open(): поток не открывался, SHA не считался.
    expect(run.failureDetail).toMatch(/распакованный размер 5000 превышает лимит элемента/);
  });

  it('коэффициент сжатия выше допустимого — отказ', async () => {
    const run = await importRejected(revisionId, [
      { name: 'бомба.json', data: Buffer.alloc(100_000, 0x61), deflate: true },
      { name: 'ok.pdf', data: fakePdf('ok') },
    ]);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    expect(run.failureDetail).toMatch(/коэффициент сжатия/);
  });

  it('суммарный распакованный объём выше лимита — отказ', async () => {
    const entries: IZipEntry[] = [0, 1, 2, 3, 4].map((i) => ({ name: `часть-${i}.pdf`, data: Buffer.alloc(4000, 0x30 + i) }));
    const run = await importRejected(revisionId, entries);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    expect(run.failureDetail).toMatch(/суммарный распакованный размер архива/);
  });

  it('число элементов архива выше лимита — отказ', async () => {
    const entries: IZipEntry[] = Array.from({ length: 8 }, (_, i) => ({ name: `заметка-${i}.txt`, data: Buffer.from('x') }));
    const run = await importRejected(revisionId, entries);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    expect(run.failureDetail).toMatch(/в архиве больше 6 элементов/);
  });

  it('metadata-файлы, допустимые по отдельности, но превышающие общий бюджет памяти, — отказ без OOM', async () => {
    const run = await importRejected(revisionId, [
      { name: 'первый.md', data: Buffer.alloc(3500, 0x61) },
      { name: 'второй.md', data: Buffer.alloc(3500, 0x62) },
    ]);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('too_large');
    expect(run.failureDetail).toMatch(/суммарный объём metadata-элементов/);
  });

  it('повтор одного пути в архиве — явный отказ, а не молчаливая подмена кандидата', async () => {
    const run = await importRejected(revisionId, [
      { name: 'дубль_blocks.json', data: Buffer.from('{"schema_version":1}') },
      { name: 'дубль_blocks.json', data: Buffer.from('{"schema_version":2}') },
    ]);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('archive_corrupt');
    expect(run.failureDetail).toMatch(/повторяющееся имя элемента/);
  });
});

describe('R04-02: отмена задания терминализует прогон', () => {
  it('отменённое queued-задание не оставляет прогон активным', async () => {
    const fx = buildRdwebExport({ docName: 'Отмена-queued' });
    const revisionId = await registerPdf('Отмена-queued.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    const jobId = await jobOfRun(accepted.body.id);

    const cancel = await s.eng1.post(`/jobs/${jobId}/cancel`, undefined, { headers: idem() });
    expect(cancel.status, cancel.text).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    const run = await runOf(accepted.body.id);
    expect(run.status).toBe('cancelled');
    expect(run.finishedAt).not.toBeNull();
    // Отмена — не ошибка: кода отказа у неё нет.
    expect(run.failureCode).toBeNull();

    // Повтор того же архива после отмены даёт новый прогон с новым заданием,
    // а не вечный reused без job.
    const again = await postExport(revisionId, fx.zip);
    expect(again.body.reused).toBe(false);
    expect(again.body.id).not.toBe(accepted.body.id);
    expect(again.body.status).toBe('queued');
    await drain(worker);
    expect((await runOf(again.body.id)).status).toBe('complete');
  });

  it('отменённое running-задание: job и прогон терминальны согласованно, старый владелец бессилен', async () => {
    const fx = buildRdwebExport({ docName: 'Отмена-running' });
    const revisionId = await registerPdf('Отмена-running.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    const runId = accepted.body.id as string;
    const jobId = await jobOfRun(runId);

    // Прежний владелец захватил задание и перевёл прогон в running.
    const stale = (await claimJob(db.pool, { workerId: 'A', leaseMs: 400, gpuGraceMs: 0, kinds: ['recognition.import'] }))!;
    expect(stale.id).toBe(jobId);
    expect(await startRun(db.pool, runId)).toBe(true);
    expect((await runOf(runId)).status).toBe('running');

    expect(await requestCancel(db.pool, jobId)).toBe('running');
    await sleep(600);
    await recoverExpiredJobs(db.pool);
    await drain(worker);

    expect((await getJob(db.pool, jobId))!.status).toBe('cancelled');
    expect((await runOf(runId)).status).toBe('cancelled');
    // Обработчик, потерявший аренду, доменную отмену подтвердить не может: до onCancel
    // дело не доходит, потому что владение не подтверждено.
    expect(await lockOwnedJob(db.pool, jobId, stale.lease_token!)).toBe(false);
  });

  it('отменённый прогон не выдаётся за «распознавание ещё идёт» и заморозку не открывает', async () => {
    const fx = buildRdwebExport({ docName: 'Отмена-заморозка' });
    const revisionId = await registerPdf('Отмена-заморозка.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    const jobId = await jobOfRun(accepted.body.id);
    await s.eng1.post(`/jobs/${jobId}/cancel`, undefined, { headers: idem() });

    const draft = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    expect(draft.status, draft.text).toBe(201);
    const put = await s.eng1.put(
      `/source-set-revisions/${draft.body.id}/items`,
      { items: [{ documentRevisionId: revisionId, inclusion: 'included' }] },
      { headers: { 'If-Match': draft.headers.etag } },
    );
    expect(put.status, put.text).toBe(200);
    const blocking = await blockingFreezeItems(db.pool, draft.body.id);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.reason).toBe('recognition_cancelled');

    const freeze = await s.eng1.post(`/source-set-revisions/${draft.body.id}/freeze`, {}, { headers: { 'If-Match': put.headers.etag, ...idem() } });
    expect(freeze.status).toBe(409);
    expect(freeze.body.current.blocking[0].reason).toBe('recognition_cancelled');
  });
});

describe('R04-03: полнота меряется по оригиналу', () => {
  it('PDF на 4 страницы и экспорт на 3 — complete невозможен', async () => {
    const fx = buildRdwebExport({ docName: 'Забытая-страница', pages: 4, omitPagesInBlocks: [3] });
    const revisionId = await registerPdf('Забытая-страница.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    await drain(worker);

    const run = await runOf(accepted.body.id);
    expect(run.status).toBe('partial');
    expect(run.pagesTotal).toBe(4);
    expect(run.pagesRecognized).toBe(3);
    expect(run.missingPages).toEqual([3]);
    expect(run.pages).toHaveLength(4);
    const codes = (run.quality.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toContain('blocks_page_count_mismatch');
  });

  it('заголовок страницы без содержимого распознаванием не считается', async () => {
    const fx = buildRdwebExport({ docName: 'Пустая-страница', pages: 4, emptyMdPages: [3] });
    const revisionId = await registerPdf('Пустая-страница.pdf', fx.pdf);
    const accepted = await postExport(revisionId, fx.zip);
    await drain(worker);

    const run = await runOf(accepted.body.id);
    expect(run.status).toBe('partial');
    expect(run.pagesTotal).toBe(4);
    expect(run.missingPages).toEqual([3]);
    expect((run.quality.warnings as { code: string }[]).map((w) => w.code)).toContain('page_output_empty');
  });

  it('полный корректный экспорт остаётся complete, A16 3/4 остаётся partial', async () => {
    const full = buildRdwebExport({ docName: 'Полный-R04' });
    const fullRev = await registerPdf('Полный-R04.pdf', full.pdf);
    const fullRun = await postExport(fullRev, full.zip);
    await drain(worker);
    expect(await runOf(fullRun.body.id)).toMatchObject({ status: 'complete', pagesTotal: 4, pagesRecognized: 4, missingPages: [] });

    const partial = buildRdwebExport({ docName: 'Неполный-R04', omitPagesInMd: [2] });
    const partialRev = await registerPdf('Неполный-R04.pdf', partial.pdf);
    const partialRun = await postExport(partialRev, partial.zip);
    await drain(worker);
    expect(await runOf(partialRun.body.id)).toMatchObject({ status: 'partial', pagesTotal: 4, pagesRecognized: 3, missingPages: [2] });
  });

  it('нечитаемый оригинал не даёт полноты: прогон отказывает явным кодом', async () => {
    const broken = fakePdf('не настоящий PDF');
    const fx = buildRdwebExport({ docName: 'Нечитаемый', pdf: broken });
    const revisionId = await registerPdf('Нечитаемый.pdf', broken);
    const accepted = await postExport(revisionId, fx.zip);
    await drain(worker);

    const run = await runOf(accepted.body.id);
    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('pdf_unreadable');
    expect(run.pagesTotal).toBeNull();
  });

  it('подсчёт страниц оригинала не ходит в сеть', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('сетевой вызов при подсчёте страниц запрещён');
    });
    try {
      const fx = buildRdwebExport({ docName: 'Без-сети' });
      const revisionId = await registerPdf('Без-сети.pdf', fx.pdf);
      const accepted = await postExport(revisionId, fx.zip);
      await drain(worker);
      expect((await runOf(accepted.body.id)).status).toBe('complete');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
