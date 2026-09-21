// Импорт результатов распознавания RDWeb из ZIP: полный цикл от загрузки архива до
// фрагмента-доказательства. Проверяются критерии этапа 04 — A16 (явная неполнота),
// A17 (повёрнутый лист и отсутствующий crop), A43 (происхождение и движок видны),
// A10 (повторный прогон того же PDF), A38 (архив и внешние ссылки безопасны).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildRdwebExport, type IRdwebFixture } from './rdweb.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
let worker: ReturnType<typeof makeWorker>;

const octet = { 'Content-Type': 'application/octet-stream' };

// Регистрация PDF штатным импортом этапа 03: SHA редакции совпадает с PDF внутри экспорта.
const registerPdf = async (name: string, pdf: Buffer, stage = s.stageA, client = s.eng1): Promise<string> => {
  const up = await client.post(`/stages/${stage}/imports?name=${encodeURIComponent(name)}`, pdf, { headers: { ...octet, ...idem() } });
  expect(up.status, up.text).toBe(202);
  await drain(worker);
  const batch = await client.get(`/imports/${up.body.id}`);
  return batch.body.items[0].documentRevisionId as string;
};

const postExport = (revisionId: string, zip: Buffer, name = 'export.zip', client = s.eng1, headers: Record<string, string> = idem()) =>
  client.post(`/document-revisions/${revisionId}/recognition-imports?name=${encodeURIComponent(name)}`, zip, { headers: { ...octet, ...headers } });

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => db.drop());

describe('импорт экспорта RDWeb', () => {
  it('полный архив: страницы, фрагменты, происхождение и событие барьера', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-полный' });
    const revisionId = await registerPdf('ТЗ-полный.pdf', fx0.pdf);
    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion;

    const accepted = await postExport(revisionId, fx0.zip);
    expect(accepted.status, accepted.text).toBe(202);
    expect(accepted.body).toMatchObject({ status: 'queued', engine: 'rdweb_export', reused: false });
    await drain(worker);

    const run = await s.eng1.get(`/recognition-runs/${accepted.body.id}`);
    expect(run.status, run.text).toBe(200);
    // A43: движок и версия схемы названы; локальная предобработка не подменяет RDWeb молча.
    expect(run.body).toMatchObject({
      status: 'complete',
      engine: 'rdweb_export',
      engineSchemaVersion: '1',
      pagesTotal: 4,
      pagesRecognized: 4,
      missingPages: [],
      contentUrl: `/api/v1/document-revisions/${revisionId}/content`,
    });
    expect(run.body.pages).toHaveLength(4);

    const fragments = (await s.eng1.get(`/recognition-runs/${accepted.body.id}/fragments`)).body;
    expect(fragments.items.length).toBeGreaterThan(10);
    // I06: распознанный текст и описание модели — разные происхождения.
    const origins = new Set(fragments.items.map((f: { origin: string }) => f.origin));
    expect([...origins].sort()).toEqual(['model_description', 'recognized_text']);
    expect(fragments.items.filter((f: { fragmentKind: string }) => f.fragmentKind === 'summary').length).toBe(4);
    expect(fragments.items.every((f: { origin: string; derivedModelRef: string | null }) => (f.origin === 'model_description') === (f.derivedModelRef !== null))).toBe(true);

    // Происхождение редакции пополнилось экспортом, а не подменило прежнее.
    const occ = await db.pool.query<{ source_kind: string }>(
      'SELECT source_kind FROM document_occurrence WHERE document_revision_id = $1 ORDER BY observed_at',
      [revisionId],
    );
    expect(occ.rows.map((r) => r.source_kind)).toEqual(['upload', 'rdweb_export']);

    const events = (await s.eng1.get(`/stages/${s.stageA}/input-events`)).body;
    expect(events.items[0]).toMatchObject({ eventType: 'recognition_run_completed', refId: accepted.body.id });
    expect(events.inputVersion).toBe(before + 1);
    expect((await auditRows(db.pool, "action = 'recognition.import.accept' AND outcome = 'allowed'")).length).toBeGreaterThan(0);
  });

  it('A16: страница без вывода — прогон partial и явный перечень нераспознанных', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-неполный', omitPagesInMd: [2] });
    const revisionId = await registerPdf('ТЗ-неполный.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    await drain(worker);

    const run = (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
    expect(run).toMatchObject({ status: 'partial', pagesTotal: 4, pagesRecognized: 3, missingPages: [2] });
    expect(run.pages.find((p: { pageIndex: number }) => p.pageIndex === 2).status).toBe('missing');
    // Неполнота обязана быть терминальным, но не «успешным» статусом: событие всё равно есть.
    const events = (await s.eng1.get(`/stages/${s.stageA}/input-events`)).body;
    expect(events.items[0]).toMatchObject({ eventType: 'recognition_run_completed', refId: accepted.body.id });
  });

  it('A17: повёрнутый лист и отсутствующий crop — открывается участок локального оригинала', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-поворот', rotate90: [1] });
    const revisionId = await registerPdf('ТЗ-поворот.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    await drain(worker);

    const fragments = (await s.eng1.get(`/recognition-runs/${accepted.body.id}/fragments?pageIndex=1`)).body.items as {
      id: string;
      externalBlockId: string | null;
      fragmentKind: string;
    }[];
    const stamp = fragments.find((f) => f.fragmentKind === 'stamp_block')!;
    const evidence = (await s.eng1.get(`/evidence/${stamp.id}`)).body;
    expect(evidence).toMatchObject({
      rotation: 90,
      bboxSpace: 'page_rotated',
      pageIndex: 1,
      pageWidthPx: 3508,
      pageHeightPx: 2480,
      externalCropUrl: null,
      contentUrl: `/api/v1/document-revisions/${revisionId}/content`,
    });
    expect(evidence.bboxNorm).toHaveLength(4);
    expect(evidence.bboxNorm.every((n: number) => typeof n === 'number' && n >= 0 && n <= 1)).toBe(true);
    // Доказательство открывается локальным оригиналом, а не внешним crop.
    const content = await s.eng1.get(`/document-revisions/${revisionId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers['x-content-sha256']).toBe(fx0.expected.pdfSha256);
  });

  it('A10: повторный экспорт того же PDF — новый прогон, прежние фрагменты сохраняются', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-повтор' });
    const revisionId = await registerPdf('ТЗ-повтор.pdf', fx0.pdf);
    const first = await postExport(revisionId, fx0.zip);
    await drain(worker);
    const firstFragments = (await s.eng1.get(`/recognition-runs/${first.body.id}/fragments`)).body.items;

    const second = buildRdwebExport({ docName: 'ТЗ-повтор', pdf: fx0.pdf, generatedAt: '2026-09-21T12:00:00Z' });
    const repeat = await postExport(revisionId, second.zip);
    expect(repeat.status, repeat.text).toBe(202);
    await drain(worker);

    const repeated = (await s.eng1.get(`/recognition-runs/${repeat.body.id}`)).body;
    expect(repeated.supersedesRunId).toBe(first.body.id);
    expect(repeated.status).toBe('complete');
    const old = (await s.eng1.get(`/recognition-runs/${first.body.id}`)).body;
    expect(old.status).toBe('complete');
    expect(old.supersededByRunId).toBe(repeat.body.id);
    // Прежние фрагменты читаются по прежним идентификаторам (I15).
    const sample = firstFragments[0] as { id: string; text: string };
    const still = await s.eng1.get(`/evidence/${sample.id}`);
    expect(still.status).toBe(200);
    expect(still.body.text).toBe(sample.text);

    const runs = (await s.eng1.get(`/document-revisions/${revisionId}/recognition-runs`)).body.items;
    expect(runs.map((r: { id: string }) => r.id)).toEqual([repeat.body.id, first.body.id]);
  });

  it('A38: небезопасный член архива отменяет импорт, опасный crop_url остаётся текстом', async () => {
    const unsafeFx = buildRdwebExport({ docName: 'ТЗ-опасный', unsafeMember: 'traversal' });
    const revisionId = await registerPdf('ТЗ-опасный.pdf', unsafeFx.pdf);
    const accepted = await postExport(revisionId, unsafeFx.zip);
    await drain(worker);
    const failed = (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'archive_unsafe', pagesTotal: null });
    expect(failed.pages).toEqual([]);
    const frags = await db.pool.query('SELECT 1 FROM evidence_fragment WHERE run_id = $1', [accepted.body.id]);
    expect(frags.rowCount).toBe(0);

    // Внешняя ссылка на внутренний адрес сохраняется как текст и никем не запрашивается.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('сетевой вызов при импорте запрещён');
    });
    try {
      const ssrfFx = buildRdwebExport({ docName: 'ТЗ-ссылки', cropUrls: 'all', cropUrlValue: 'http://127.0.0.1:3000/api/v1/admin/users' });
      const rev2 = await registerPdf('ТЗ-ссылки.pdf', ssrfFx.pdf);
      const ok = await postExport(rev2, ssrfFx.zip);
      await drain(worker);
      expect((await s.eng1.get(`/recognition-runs/${ok.body.id}`)).body.status).toBe('complete');
      const items = (await s.eng1.get(`/recognition-runs/${ok.body.id}/fragments`)).body.items as { externalCropUrl: string | null }[];
      expect(items.some((f) => f.externalCropUrl?.startsWith('http://127.0.0.1:3000/api/v1/admin/users'))).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('чужой PDF не принимается и не порождает события барьера', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-чужой' });
    const revisionId = await registerPdf('ТЗ-чужой.pdf', fx0.pdf);
    const alien = buildRdwebExport({ docName: 'Другой документ' });
    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion;

    const accepted = await postExport(revisionId, alien.zip);
    expect(accepted.status).toBe(202);
    await drain(worker);
    const run = (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
    expect(run).toMatchObject({ status: 'failed', failureCode: 'pdf_mismatch' });
    expect((await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion).toBe(before);
  });

  it('отказы формата архива видны кодом причины', async () => {
    const cases: [IRdwebFixture, string][] = [
      [{ omit: ['blocks'] }, 'blocks_json_missing'],
      [{ omit: ['md'] }, 'results_md_missing'],
      [{ omit: ['pdf'] }, 'pdf_missing'],
      [{ brokenJson: true }, 'blocks_json_invalid'],
      [{ schemaVersion: 2 }, 'schema_version_unsupported'],
      [{ coordinateSpace: 'pdf_user_space' }, 'coordinate_space_unsupported'],
    ];
    for (const [fixture, code] of cases) {
      const base = buildRdwebExport({ docName: `ТЗ-${code}` });
      const revisionId = await registerPdf(`ТЗ-${code}.pdf`, base.pdf);
      const fx = buildRdwebExport({ docName: `ТЗ-${code}`, pdf: base.pdf, ...fixture });
      const accepted = await postExport(revisionId, fx.zip);
      await drain(worker);
      const run = (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
      expect(run.status, `${code}: ${JSON.stringify(run)}`).toBe('failed');
      expect(run.failureCode).toBe(code);
    }
  });

  it('лишние члены архива не мешают: прогон complete с предупреждениями', async () => {
    const fx0 = buildRdwebExport({
      docName: 'ТЗ-лишнее',
      omit: ['html'],
      extraMembers: [{ name: 'заметки.txt', data: Buffer.from('служебная заметка') }],
    });
    const revisionId = await registerPdf('ТЗ-лишнее.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    await drain(worker);
    const run = (await s.eng1.get(`/recognition-runs/${accepted.body.id}`)).body;
    expect(run.status).toBe('complete');
    const codes = (run.quality.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['unexpected_member', 'results_html_missing']));
  });

  it('неизвестный тип блока импортируется с пометкой', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-таблица', unknownBlockTypes: ['table'] });
    const revisionId = await registerPdf('ТЗ-таблица.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    await drain(worker);
    const items = (await s.eng1.get(`/recognition-runs/${accepted.body.id}/fragments?pageIndex=0`)).body.items as {
      fragmentKind: string;
      externalBlockId: string;
      warnings: string[];
    }[];
    const unknown = items.find((f) => f.externalBlockId === fx0.expected.unknownBlockIds[0])!;
    expect(unknown.fragmentKind).toBe('unknown_block');
    expect(unknown.warnings).toContain('unknown_block_type');
  });

  it('идемпотентность: повтор ключа — тот же ответ, другой ключ с тем же архивом — тот же прогон', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-идемпотентность' });
    const revisionId = await registerPdf('ТЗ-идемпотентность.pdf', fx0.pdf);
    const key = idem();
    const first = await postExport(revisionId, fx0.zip, 'export.zip', s.eng1, key);
    const replay = await postExport(revisionId, fx0.zip, 'export.zip', s.eng1, key);
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    const other = await postExport(revisionId, fx0.zip, 'export.zip', s.eng1, idem());
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ id: first.body.id, reused: true });
    const runs = await db.pool.query('SELECT count(*)::int AS n FROM recognition_run WHERE document_revision_id = $1', [revisionId]);
    expect(runs.rows[0].n).toBe(1);
  });

  it('не-ZIP тело отклоняется до создания прогона', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-не-архив' });
    const revisionId = await registerPdf('ТЗ-не-архив.pdf', fx0.pdf);
    const bad = await postExport(revisionId, fx0.pdf, 'export.zip');
    expect(bad.status).toBe(400);
    const runs = await db.pool.query('SELECT count(*)::int AS n FROM recognition_run WHERE document_revision_id = $1', [revisionId]);
    expect(runs.rows[0].n).toBe(0);
  });

  it('область: чужой тендер не видит импорт, прогон и фрагмент', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-область' });
    const revisionId = await registerPdf('ТЗ-область.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    await drain(worker);
    const fragmentId = (await s.eng1.get(`/recognition-runs/${accepted.body.id}/fragments`)).body.items[0].id;

    expect((await postExport(revisionId, fx0.zip, 'export.zip', s.eng3)).status).toBe(404);
    expect((await s.eng3.get(`/recognition-runs/${accepted.body.id}`)).status).toBe(404);
    expect((await s.eng3.get(`/recognition-runs/${accepted.body.id}/fragments`)).status).toBe(404);
    expect((await s.eng3.get(`/evidence/${fragmentId}`)).status).toBe(404);
    expect((await s.eng3.get(`/document-revisions/${revisionId}/recognition-runs`)).status).toBe(404);
  });

  it('отмена задания распознавания доступна участнику тендера', async () => {
    const fx0 = buildRdwebExport({ docName: 'ТЗ-отмена' });
    const revisionId = await registerPdf('ТЗ-отмена.pdf', fx0.pdf);
    const accepted = await postExport(revisionId, fx0.zip);
    const job = await db.pool.query<{ id: string }>("SELECT id FROM job WHERE kind = 'recognition.import' AND payload->>'runId' = $1", [accepted.body.id]);
    const cancel = await s.eng1.post(`/jobs/${job.rows[0]!.id}/cancel`, undefined, {});
    expect(cancel.status, cancel.text).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
  });
});
