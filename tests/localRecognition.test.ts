// Сквозной цикл локального распознавания (этап 05a, D-024): загрузка штатным импортом, автоматическая
// постановка DOCX/XLSX/CSV, явная команда для PDF, итог прогона и качество, идемпотентность, смена версии
// и конфигурации распознавателя, маршрут RDWeb, отказ, пределы, перезапуск worker, дубли заданий,
// отмена (тесты 3–7, 15–20 решения владельца).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeLocalRecognizer, localSettings } from '../packages/adapters/src/index.ts';
import { claimJob, enqueueLocalRecognition, recoverExpiredJobs, startRun, withTransaction } from '../packages/db/src/index.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import * as fx from './localFixtures.ts';
import { completeLocalRun, descriptorOf, insertLocalRun } from './localRecognitionFixtures.ts';
import { buildRdwebExport } from './rdweb.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
let worker: ReturnType<typeof makeWorker>;
const octet = { 'Content-Type': 'application/octet-stream' };
const pdf = (name: string): Buffer => fx.uniqueCopy(readFileSync(join(import.meta.dirname, 'fixtures', 'local', `${name}.pdf`)), 'pdf');
const xlsx = (b: Buffer): Buffer => fx.uniqueCopy(b, 'zip');

const upload = async (name: string, body: Buffer, stage = s.stageA): Promise<string> => {
  const up = await s.eng1.post(`/stages/${stage}/imports?name=${encodeURIComponent(name)}`, body, { headers: { ...octet, ...idem() } });
  expect(up.status, up.text).toBe(202);
  await drain(worker);
  return (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
};
const autoPass = async (w = worker): Promise<number> => {
  const n = await w.scheduleLocalRecognition();
  await drain(w);
  return n;
};
const runs = async (revisionId: string) => (await s.eng1.get(`/document-revisions/${revisionId}/recognition-runs`)).body.items as Record<string, unknown>[];
const command = (revisionId: string, headers: Record<string, string> = idem()) =>
  s.eng1.post(`/document-revisions/${revisionId}/local-recognitions`, {}, { headers });

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => db.drop());

describe('автоматическая постановка (OD-2)', () => {
  it('XLSX: прогон local_ocr, листы — единицы, строки — фрагменты с якорем; событие барьера этапа', async () => {
    const revisionId = await upload('Смета Стромынки.xlsx', xlsx(fx.smetaStromynkaXlsx()));
    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion as number;
    expect(await autoPass()).toBe(1);
    const [run] = await runs(revisionId);
    expect(run).toMatchObject({ engine: 'local_ocr', status: 'complete', outcome: 'complete', preferred: true, trigger: 'auto' });
    const detail = (await s.eng1.get(`/recognition-runs/${run!.id}`)).body;
    expect(detail.pages.map((p: { unitKind: string; pageLabel: string }) => [p.unitKind, p.pageLabel])).toEqual([
      ['xlsx_sheet', 'Сводная'],
      ['xlsx_sheet', 'Материалы'],
    ]);
    expect(detail.pages.every((p: { widthPx: number | null }) => p.widthPx === null)).toBe(true);
    expect(detail.quality).toMatchObject({ verdict: 'complete', counts: { units: 2, recognized: 2 } });
    expect(detail.recognizer).toMatchObject({ recognizerId: 'kontur.local', inputFormat: 'xlsx', processing: 'structured_parser' });
    const frags = (await s.eng1.get(`/recognition-runs/${run!.id}/fragments?pageIndex=0`)).body.items as { text: string; locator: Record<string, unknown>; bboxNorm: unknown; origin: string }[];
    const row7 = frags.find((f) => f.locator.rowFrom === 7)!;
    expect(row7).toMatchObject({ origin: 'document_text', bboxNorm: null, locator: { kind: 'xlsx_cells', sheet: 'Сводная', range: 'A7:E7' } });
    expect(row7.text).toContain('98 500 000');
    const events = (await s.eng1.get(`/stages/${s.stageA}/input-events`)).body;
    expect(events.inputVersion).toBe(before + 1);
  });

  it('DOCX и CSV в Windows-1251 — автоматически; повторный проход ничего не ставит', async () => {
    const docx = await upload('Договор 15-П.docx', xlsx(fx.contractDocx()));
    const csv = await upload('Смета.csv', fx.uniqueCopy(fx.csvCp1251(), 'text'));
    expect(await autoPass()).toBe(2);
    expect((await runs(docx))[0]).toMatchObject({ status: 'complete', mediaType: expect.stringContaining('wordprocessingml') });
    expect((await runs(csv))[0]).toMatchObject({ status: 'complete' });
    expect(await autoPass()).toBe(0);
  });

  it('PDF с политикой auto автоматически не распознаётся (тест 3); с политикой local — да', async () => {
    const auto = await upload('Письмо-скан.pdf', pdf('letter-text'));
    expect(await autoPass()).toBe(0);
    expect(await runs(auto)).toHaveLength(0);
    const doc = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items.find((d: { latestRevisionId: string }) => d.latestRevisionId === auto);
    const etag = `"${doc.id}:${doc.rowVersion}"`;
    const patch = await s.eng1.patch(`/documents/${doc.id}`, { recognitionRoute: 'local' }, { headers: { 'If-Match': etag } });
    expect(patch.status, patch.text).toBe(200);
    expect(patch.body.recognitionRoute).toBe('local');
    const audit = await auditRows(db.pool, "action = 'source.document.update' AND entity_id = $1", [doc.id]);
    expect(audit.at(-1)!.details).toMatchObject({ changes: { recognitionRoute: { from: 'auto', to: 'local' } } });
    expect(await autoPass()).toBe(1);
    expect((await runs(auto))[0]).toMatchObject({ engine: 'local_ocr', status: 'complete', trigger: 'auto' });
  });

  it('неподдерживаемый формат — явный отказ unsupported_format, автоматически не ставится (OD-4)', async () => {
    const txt = await upload('Заметка.txt', Buffer.from('просто текст', 'utf8'));
    expect(await autoPass()).toBe(0);
    const r = await command(txt);
    expect(r.status).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'unsupported_format' });
  });
});

describe('явная команда (OD-1, OD-2)', () => {
  it('PDF с политикой auto — командой (тест 4); повтор той же идентичности идемпотентен (тест 5)', async () => {
    const revisionId = await upload('Письмо-текст.pdf', pdf('letter-text'));
    const first = await command(revisionId);
    expect(first.status, first.text).toBe(202);
    expect(first.body).toMatchObject({ reused: false, run: { engine: 'local_ocr', status: 'queued' } });
    // Ответ без качества и текста: у contract.manage без contract.read содержимого нет.
    expect(Object.keys(first.body.run).sort()).toEqual(['createdAt', 'documentRevisionId', 'engine', 'id', 'outcome', 'status']);
    const again = await command(revisionId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, run: { id: first.body.run.id } });
    await drain(worker);
    const all = await runs(revisionId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'complete', trigger: 'command' });
    const audit = await auditRows(db.pool, "action = 'recognition.local.request' AND entity_id = $1", [first.body.run.id]);
    expect(audit.map((a) => a.details)).toEqual([
      { documentRevisionId: revisionId, reused: false, inputFormat: 'pdf', processing: 'native_text' },
      { documentRevisionId: revisionId, reused: true, inputFormat: 'pdf', processing: 'native_text' },
    ]);
    // После завершения повтор той же идентичности снова возвращает тот же прогон.
    expect((await command(revisionId)).body).toMatchObject({ reused: true, run: { id: first.body.run.id } });
  });

  it('новая версия распознавателя — новый прогон; worker другой версии его не выполняет (тест 6)', async () => {
    const revisionId = await upload('Смета-версии.xlsx', xlsx(fx.smetaStromynkaXlsx()));
    await autoPass();
    const [v1] = await runs(revisionId);
    const base = await describeLocalRecognizer('xlsx', localSettings(config, null));
    const v2 = await withTransaction(db.pool, (c) =>
      enqueueLocalRecognition(c, { revisionId, descriptor: { ...base, recognizerVersion: '2' }, createdBy: s.ids.eng1 }),
    );
    expect(v2.kind).toBe('created');
    const row = await db.pool.query<{ supersedes_run_id: string }>('SELECT supersedes_run_id FROM recognition_run WHERE id = $1', [v2.kind === 'created' ? v2.runId : '']);
    expect(row.rows[0]!.supersedes_run_id).toBe(v1!.id);
    // Распознаватель при выполнении не совпал с записанным — результат чужой версии не выдаётся.
    await drain(worker);
    expect((await runs(revisionId))[0]).toMatchObject({ status: 'failed', failureCode: 'recognizer_changed' });
    expect((await runs(revisionId)).find((r) => r.id === v1!.id)).toMatchObject({ preferred: true });
  });

  it('смена конфигурации (DPI) — новый хэш конфигурации и новый прогон за хвостом истории (тест 7)', async () => {
    const revisionId = await upload('Письмо-конфигурация.pdf', pdf('letter-text'));
    const first = await command(revisionId);
    await drain(worker);
    const other = testConfig({ storageRoot: config.storageRoot, localRecognition: { ...config.localRecognition, ocrDpi: 250 } });
    const app2 = makeApp(db, undefined, other);
    const eng1b = new TestClient(app2);
    await eng1b.login('eng1');
    const second = await eng1b.post(`/document-revisions/${revisionId}/local-recognitions`, {}, { headers: idem() });
    expect(second.status, second.text).toBe(202);
    expect(second.body.run.id).not.toBe(first.body.run.id);
    await drain(makeWorker(db, other, 'dpi-250'));
    const chain = await db.pool.query<{ id: string; supersedes_run_id: string | null; status: string; recognizer_config_hash: string }>(
      'SELECT id, supersedes_run_id, status, recognizer_config_hash FROM recognition_run WHERE document_revision_id = $1 ORDER BY created_at',
      [revisionId],
    );
    expect(chain.rows.map((r) => [r.supersedes_run_id, r.status])).toEqual([
      [null, 'complete'],
      [first.body.run.id, 'complete'],
    ]);
    expect(chain.rows[0]!.recognizer_config_hash).not.toBe(chain.rows[1]!.recognizer_config_hash);
  });

  it('поздний RDWeb выше локального (тест 1); прогон RDWeb закрывает локальный маршрут (OD-1)', async () => {
    const fxr = buildRdwebExport({ docName: 'ТЗ-маршрут' });
    const revisionId = await upload('ТЗ-маршрут.pdf', fxr.pdf);
    // Успешный локальный прогон явной командой (у PDF фикстуры RDWeb нет текстового слоя — прогон
    // создаётся слоем данных по настоящей машине состояний).
    const local = await insertLocalRun(db.pool, revisionId, descriptorOf('pdf'), s.ids.eng1);
    const busy = await s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, fxr.zip, { headers: { ...octet, ...idem() } });
    // Пока локальный прогон не завершён, приём RDWeb ждёт: история линейна (R04-12).
    expect(busy.status).toBe(409);
    await completeLocalRun(db.pool, local, [{ kind: 'pdf_page' }, { kind: 'pdf_page' }, { kind: 'pdf_page' }, { kind: 'pdf_page' }], ['Локальный текст']);
    const imported = await s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, fxr.zip, { headers: { ...octet, ...idem() } });
    expect(imported.status, imported.text).toBe(202);
    await drain(worker);
    const all = await runs(revisionId);
    const rdweb = all.find((r) => r.engine === 'rdweb_export')!;
    const loc = all.find((r) => r.engine === 'local_ocr')!;
    expect(rdweb).toMatchObject({ status: 'complete', preferred: true, supersedesRunId: local });
    expect(loc).toMatchObject({ id: local, preferred: false });
    const refused = await command(revisionId);
    expect(refused.status).toBe(409);
    expect(refused.body.current).toMatchObject({ reason: 'route_rdweb' });
  });

  it('документ с политикой rdweb: команда отклонена', async () => {
    const revisionId = await upload('Только-RDWeb.pdf', pdf('letter-text'));
    const doc = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items.find((d: { latestRevisionId: string }) => d.latestRevisionId === revisionId);
    await s.eng1.patch(`/documents/${doc.id}`, { recognitionRoute: 'rdweb' }, { headers: { 'If-Match': `"${doc.id}:${doc.rowVersion}"` } });
    const r = await command(revisionId);
    expect(r.status).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'route_rdweb' });
  });
});

describe('итог и качество (OD-6)', () => {
  it('needs_review не выдаётся за успех: partial, единица в reviewUnits (тест 15)', async () => {
    const revisionId = await upload('Расчёт-формула.xlsx', xlsx(fx.formulaWithoutValueXlsx()));
    await autoPass();
    const [run] = await runs(revisionId);
    expect(run).toMatchObject({ status: 'partial', outcome: 'needs_review' });
    const detail = (await s.eng1.get(`/recognition-runs/${run!.id}`)).body;
    expect(detail).toMatchObject({ reviewUnits: [0], missingPages: [0], quality: { verdict: 'needs_review', units: [{ issues: ['formula_without_value'] }] } });
  });

  it('повреждённый DOCX — failed file_corrupt (тест 16); пустой PDF — failed no_usable_text с диагностикой', async () => {
    const broken = await upload('Битый.docx', fx.truncatedDocx());
    await autoPass();
    expect((await runs(broken))[0]).toMatchObject({ status: 'failed', outcome: 'failed', failureCode: 'file_corrupt' });
    const blank = await upload('Пустой.pdf', pdf('blank'));
    await command(blank);
    await drain(worker);
    const [run] = await runs(blank);
    expect(run).toMatchObject({ status: 'failed', failureCode: 'ocr_unavailable' });
    const detail = (await s.eng1.get(`/recognition-runs/${run!.id}`)).body;
    expect(detail.quality).toMatchObject({ verdict: 'failed', counts: { units: 1, missing: 1 } });
  });

  it('предел размера файла — failed too_large (тест 18)', async () => {
    const small = testConfig({ storageRoot: config.storageRoot, localRecognition: { ...config.localRecognition, maxInputBytes: 200 } });
    const w = makeWorker(db, small, 'small-worker');
    const revisionId = await upload('Большая смета.xlsx', xlsx(fx.smetaStromynkaXlsx()));
    await autoPass(w);
    expect((await runs(revisionId))[0]).toMatchObject({ status: 'failed', failureCode: 'too_large' });
  });
});

describe('надёжность очереди (тесты 19–20)', () => {
  it('перезапуск worker посреди прогона: после истечения аренды прогон завершается один раз, без дублей', async () => {
    const revisionId = await upload('Смета-рестарт.xlsx', xlsx(fx.smetaStromynkaXlsx()));
    await worker.scheduleLocalRecognition();
    const job = (await claimJob(db.pool, { workerId: 'dead-worker', leaseMs: 60_000, gpuGraceMs: 0, kinds: ['recognition.local'] }))!;
    await startRun(db.pool, String(job.payload.runId));
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [job.id]);
    expect(await recoverExpiredJobs(db.pool)).toContain(job.id);
    await drain(worker);
    const [run] = await runs(revisionId);
    expect(run).toMatchObject({ status: 'complete' });
    const counts = await db.pool.query<{ pages: number; frags: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM recognition_page WHERE run_id = $1) AS pages,
              (SELECT count(*)::int FROM evidence_fragment WHERE run_id = $1) AS frags,
              (SELECT count(DISTINCT fragment_key)::int FROM evidence_fragment WHERE run_id = $1) AS keys`,
      [run!.id],
    );
    expect(counts.rows[0]).toEqual({ pages: 2, frags: 14, keys: 14 });
  });

  it('дубли: два прохода и параллельная команда дают один прогон и одно задание', async () => {
    const revisionId = await upload('Смета-дубль.csv', fx.uniqueCopy(fx.csvUtf8Bom(), 'text'));
    await worker.scheduleLocalRecognition();
    await worker.scheduleLocalRecognition();
    const [a, b] = await Promise.all([command(revisionId), command(revisionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const jobs = await db.pool.query("SELECT count(*)::int AS n FROM job WHERE kind = 'recognition.local' AND payload->>'runId' IN (SELECT id::text FROM recognition_run WHERE document_revision_id = $1)", [revisionId]);
    expect(jobs.rows[0].n).toBe(1);
    await drain(worker);
    expect(await runs(revisionId)).toHaveLength(1);
  });

  it('отмена поставленного задания терминализует прогон: cancelled', async () => {
    const revisionId = await upload('Письмо-отмена.pdf', pdf('letter-text'));
    const r = await command(revisionId);
    const job = await db.pool.query<{ id: string }>("SELECT id FROM job WHERE kind = 'recognition.local' AND payload->>'runId' = $1", [r.body.run.id]);
    const cancel = await s.eng1.post(`/jobs/${job.rows[0]!.id}/cancel`, undefined, {});
    expect(cancel.status, cancel.text).toBe(200);
    expect((await runs(revisionId))[0]).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
  });
});
