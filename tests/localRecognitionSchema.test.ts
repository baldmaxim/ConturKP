// Вторая линия БД этапа 05a (миграция 0014): прямые операции под ролью приложения. Маршрут и формат
// (OD-1, OD-4), идентичность и повтор (AD-05a-2, тесты 5–7 решения владельца), единица источника и
// якорь (AD-05a-1), предпочтительный прогон «RDWeb выше локального» (AD-05a-3, тесты 1–2) и его
// охранники в снимке и прогоне поиска.
import pg from 'pg';
import { evidenceScopeContentHash } from '../packages/core/src/index.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceScope, finishRun, insertFragments, insertPages, preferredRunId, recognizerFingerprint } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, makeApp, seedRecognition, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { completeLocalRun, descriptorOf, insertLocalRun, newRevision, sqlCode, startRunSql } from './localRecognitionFixtures.ts';
import { setWorkingSet } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, testConfig()));
});
afterAll(async () => db.drop());

const rev = (format: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt', route: 'auto' | 'local' | 'rdweb' = 'auto') =>
  newRevision(db.pool, { tenderId: s.tenderA, format, route, userId: s.ids.eng1 });

describe('маршрут и формат (OD-1, OD-4)', () => {
  it('DOCX, XLSX, CSV ставятся и автоматически; неподдерживаемый формат — отказ БД', async () => {
    for (const f of ['docx', 'xlsx', 'csv'] as const) {
      const r = await rev(f);
      expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf(f), null))).toBe('ok');
    }
    const txt = await rev('txt');
    expect(await sqlCode(insertLocalRun(db.pool, txt.revisionId, descriptorOf('csv'), s.ids.eng1))).toBe('23514');
  });

  it('PDF с политикой auto: автоматически — нет, явной командой (с автором) — да (тест 3–4)', async () => {
    const r = await rev('pdf');
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), null))).toBe('23514');
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), s.ids.eng1))).toBe('ok');
  });

  it('PDF с политикой local — автоматически можно; с политикой rdweb — нельзя никак', async () => {
    const local = await rev('pdf', 'local');
    expect(await sqlCode(insertLocalRun(db.pool, local.revisionId, descriptorOf('pdf'), null))).toBe('ok');
    const only = await rev('pdf', 'rdweb');
    expect(await sqlCode(insertLocalRun(db.pool, only.revisionId, descriptorOf('pdf'), s.ids.eng1))).toBe('23514');
  });

  it('PDF с прогоном RDWeb (идущим или успешным) — маршрут rdweb, локальный не ставится (OD-1 п. 1–2, D-014)', async () => {
    const r = await rev('pdf', 'local');
    await seedRecognition(db.pool, r.revisionId, 'complete');
    const route = await db.pool.query<{ route: string }>('SELECT recognition_revision_route($1) AS route', [r.revisionId]);
    expect(route.rows[0]!.route).toBe('rdweb');
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), s.ids.eng1))).toBe('23514');
  });

  it('источник — оригинал редакции без имени файла; описание распознавателя проверяет БД (AD-05a-2)', async () => {
    const r = await rev('docx');
    const bad = (sql: string, params: unknown[]) => sqlCode(db.pool.query(sql, params));
    const base = `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, source_artifact_name, created_by, recognizer)
                  VALUES ($1, $2, 'local_ocr', $3, $4, $5, $6::jsonb)`;
    expect(await bad(base, [r.revisionId, s.tenderA, r.sha, 'contract.docx', null, JSON.stringify(descriptorOf('docx'))])).toBe('23514');
    const other = await rev('docx');
    expect(await bad(base, [r.revisionId, s.tenderA, other.sha, null, null, JSON.stringify(descriptorOf('docx'))])).toBe('23514');
    // Формат описания не совпадает с оригиналом; языки не отсортированы; лишнее поле.
    expect(await bad(base, [r.revisionId, s.tenderA, r.sha, null, null, JSON.stringify(descriptorOf('xlsx'))])).toBe('23514');
    const pdf = await rev('pdf', 'local');
    const unsorted = descriptorOf('pdf', { processing: 'native_text+ocr', languages: ['rus', 'eng'] });
    expect(await bad(base, [pdf.revisionId, s.tenderA, pdf.sha, null, null, JSON.stringify(unsorted)])).toBe('23514');
    expect(await bad(base, [r.revisionId, s.tenderA, r.sha, null, null, JSON.stringify({ ...descriptorOf('docx'), path: 'C:\\tmp\\x.docx' })])).toBe('23514');
    // У прогона RDWeb описания распознавателя нет.
    expect(
      await bad(
        `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, recognizer) VALUES ($1, $2, 'rdweb_export', $3, $4::jsonb)`,
        [r.revisionId, s.tenderA, r.sha, JSON.stringify(descriptorOf('docx'))],
      ),
    ).toBe('23514');
  });

  it('отпечаток и хэш конфигурации считает БД; клиентское значение не принимается', async () => {
    const r = await rev('csv');
    const d = descriptorOf('csv');
    const run = await db.pool.query<{ recognizer_fingerprint: string; recognizer_config_hash: string }>(
      `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, recognizer, recognizer_fingerprint, recognizer_config_hash)
       VALUES ($1, $2, 'local_ocr', $3, $4::jsonb, $5, $5) RETURNING recognizer_fingerprint, recognizer_config_hash`,
      [r.revisionId, s.tenderA, r.sha, JSON.stringify(d), '0'.repeat(64)],
    );
    expect(run.rows[0]!.recognizer_fingerprint).toBe(await recognizerFingerprint(db.pool, d as never));
    expect(run.rows[0]!.recognizer_config_hash).not.toBe('0'.repeat(64));
    // Порядок ключей описания на отпечаток не влияет (канонический jsonb).
    const reordered = { config: d.config, languages: d.languages, processing: d.processing, inputFormat: d.inputFormat, recognizerVersion: '1', recognizerId: 'kontur.local' };
    expect(await recognizerFingerprint(db.pool, reordered as never)).toBe(run.rows[0]!.recognizer_fingerprint);
  });
});

describe('идентичность и повтор (AD-05a-2, тесты 5–7)', () => {
  it('та же идентичность — второй прогон невозможен; новая версия и новая конфигурация — новый прогон', async () => {
    const r = await rev('xlsx');
    const first = await insertLocalRun(db.pool, r.revisionId, descriptorOf('xlsx'), null);
    await completeLocalRun(db.pool, first, [{ kind: 'xlsx_sheet' }], ['Смета | 1']);
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('xlsx'), null))).toBe('23505');
    const v2 = await insertLocalRun(db.pool, r.revisionId, descriptorOf('xlsx', { recognizerVersion: '2' }), null);
    await completeLocalRun(db.pool, v2, [{ kind: 'xlsx_sheet' }], ['Смета | 1']);
    const cfg = await insertLocalRun(db.pool, r.revisionId, descriptorOf('xlsx', { config: { parser: 'xlsx', numbers: 'ru-2' } }), null);
    const rows = await db.pool.query<{ id: string; supersedes_run_id: string | null; recognizer_config_hash: string }>(
      'SELECT id, supersedes_run_id, recognizer_config_hash FROM recognition_run WHERE id = ANY($1::uuid[]) ORDER BY created_at',
      [[first, v2, cfg]],
    );
    // Новые прогоны встают за хвостом истории; хэш конфигурации различается.
    expect(rows.rows.map((x) => x.supersedes_run_id)).toEqual([null, first, v2]);
    expect(new Set(rows.rows.map((x) => x.recognizer_config_hash)).size).toBe(2);
  });

  it('после отказа та же идентичность ставится снова (сбой мог быть техническим)', async () => {
    const r = await rev('csv');
    const run = await insertLocalRun(db.pool, r.revisionId, descriptorOf('csv'), null);
    await db.pool.query("UPDATE recognition_run SET status = 'failed', failure_code = 'x', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [run]);
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('csv'), null))).toBe('ok');
  });

  it('описание распознавателя, отпечаток и владелец неизменяемы после вставки', async () => {
    const r = await rev('docx');
    const run = await insertLocalRun(db.pool, r.revisionId, descriptorOf('docx'), null);
    const upd = (set: string) => sqlCode(db.pool.query(`UPDATE recognition_run SET ${set}, row_version = row_version + 1 WHERE id = $1`, [run]));
    expect(await upd(`recognizer = '${JSON.stringify(descriptorOf('docx', { recognizerVersion: '9' }))}'::jsonb`)).toBe('55000');
    expect(await upd(`recognizer_fingerprint = '${'1'.repeat(64)}'`)).toBe('55000');
    expect(await upd('tender_id = NULL')).not.toBe('ok');
  });
});

describe('единица источника и якорь (AD-05a-1)', () => {
  const running = async (format: 'xlsx' | 'csv' | 'docx' | 'pdf') => {
    const r = await rev(format, 'local');
    const run = await insertLocalRun(db.pool, r.revisionId, descriptorOf(format), format === 'pdf' ? s.ids.eng1 : null);
    await startRunSql(db.pool, run);
    return { run, revisionId: r.revisionId };
  };
  const page = (run: string, o: { kind: string; width?: number | null; status?: string; rotation?: number }) =>
    sqlCode(
      db.pool.query('INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, 0, $2, $3, $3, $4, $5)', [
        run,
        o.kind,
        o.width ?? null,
        o.rotation ?? 0,
        o.status ?? 'recognized',
      ]),
    );

  it('логическая единица без пикселей; фиктивные размеры и поворот отклоняются', async () => {
    const x = await running('xlsx');
    expect(await page(x.run, { kind: 'xlsx_sheet', width: 1 })).toBe('23514');
    expect(await page(x.run, { kind: 'xlsx_sheet', rotation: 90 })).toBe('23514');
    expect(await page(x.run, { kind: 'pdf_page', width: 100 })).toBe('23514');
    expect(await page(x.run, { kind: 'xlsx_sheet' })).toBe('ok');
  });

  it('распознанная страница PDF обязана иметь размеры; у RDWeb — только страницы PDF и без needs_review', async () => {
    const p = await running('pdf');
    expect(await page(p.run, { kind: 'pdf_page' })).toBe('23514');
    expect(await page(p.run, { kind: 'pdf_page', width: 1654 })).toBe('ok');
    const rd = await rev('pdf');
    const rdRun = await seedRecognition(db.pool, rd.revisionId, 'running');
    expect(await page(rdRun, { kind: 'xlsx_sheet' })).toBe('23514');
    expect(await page(rdRun, { kind: 'pdf_page', width: 2480, status: 'needs_review' })).toBe('23514');
  });

  it('локальный фрагмент: якорь обязателен и согласован с единицей, координат нет, происхождение по способу', async () => {
    const x = await running('xlsx');
    await page(x.run, { kind: 'xlsx_sheet' });
    const run = (await db.pool.query<{ tender_id: string }>('SELECT tender_id FROM recognition_run WHERE id = $1', [x.run])).rows[0]!;
    const frag = (over: Record<string, unknown>) =>
      sqlCode(
        insertFragments(db.pool, { runId: x.run, tenderId: run.tender_id, contractId: null, documentRevisionId: x.revisionId }, [
          {
            origin: 'document_text',
            fragmentKind: 'text_block',
            fragmentKey: `k${Math.random()}`,
            externalBlockId: null,
            ordinal: 1,
            pageIndex: 0,
            bboxNorm: null,
            bboxSpace: null,
            shapeType: null,
            polygonNorm: null,
            rotation: null,
            text: 'Бетон B30 | 7 450',
            textSha256: 'a'.repeat(64),
            derivedModelRef: null,
            externalCropUrl: null,
            warnings: [],
            partIndex: 0,
            partTotal: 1,
            locator: { kind: 'xlsx_cells', sheet: 'Материалы', sheetIndex: 1, range: 'A4:E4', rowFrom: 4, rowTo: 4, colFrom: 1, colTo: 5 },
            ...over,
          },
        ]),
      );
    expect(await frag({ locator: null })).toBe('23514');
    expect(await frag({ bboxNorm: [0.1, 0.1, 0.2, 0.2], bboxSpace: 'page_rotated' })).toBe('23514');
    expect(await frag({ locator: { kind: 'csv_rows', rowFrom: 1, rowTo: 1, colFrom: 1, colTo: 1, headerRow: null, lineFrom: 1, lineTo: 1 } })).toBe('23514');
    expect(await frag({ locator: { kind: 'xlsx_cells', sheet: 'Материалы', sheetIndex: 2, range: 'A4:E4', rowFrom: 4, rowTo: 4, colFrom: 1, colTo: 5 } })).toBe('23514');
    expect(await frag({ locator: { kind: 'xlsx_cells', sheet: 'Материалы', sheetIndex: 1, range: 'A4', rowFrom: 4, rowTo: 4, colFrom: 1, colTo: 5 } })).toBe('23514');
    expect(await frag({ origin: 'recognized_text' })).toBe('23514');
    expect(await frag({})).toBe('ok');
    // У фрагмента RDWeb якоря нет.
    const rd = await rev('pdf');
    const rdRun = await seedRecognition(db.pool, rd.revisionId, 'running');
    await page(rdRun, { kind: 'pdf_page', width: 2480 });
    expect(
      await sqlCode(
        insertFragments(db.pool, { runId: rdRun, tenderId: s.tenderA, contractId: null, documentRevisionId: rd.revisionId }, [
          {
            origin: 'recognized_text',
            fragmentKind: 'text_block',
            fragmentKey: 'rd',
            externalBlockId: null,
            ordinal: 1,
            pageIndex: 0,
            bboxNorm: null,
            bboxSpace: null,
            shapeType: null,
            polygonNorm: null,
            rotation: null,
            text: 'текст',
            textSha256: 'b'.repeat(64),
            derivedModelRef: null,
            externalCropUrl: null,
            warnings: [],
            partIndex: 0,
            partTotal: 1,
            locator: { kind: 'pdf_text', page: 1, method: 'ocr', block: 1 },
          },
        ]),
      ),
    ).toBe('23514');
  });

  it('полнота прежняя: needs_review не считается распознанной, complete без всех единиц невозможен (I18)', async () => {
    const x = await running('xlsx');
    await insertPages(db.pool, x.run, [
      { pageIndex: 0, pageLabel: 'Лист 1', sheetLabel: null, widthPx: null, heightPx: null, rotation: 0, status: 'recognized', unitKind: 'xlsx_sheet' },
      { pageIndex: 1, pageLabel: 'Лист 2', sheetLabel: null, widthPx: null, heightPx: null, rotation: 0, status: 'needs_review', unitKind: 'xlsx_sheet' },
    ]);
    expect(await sqlCode(finishRun(db.pool, x.run, { status: 'complete', engineSchemaVersion: 't', pagesTotal: 2, pagesRecognized: 2, quality: {} }))).toBe('23514');
    expect(await finishRun(db.pool, x.run, { status: 'partial', engineSchemaVersion: 't', pagesTotal: 2, pagesRecognized: 1, quality: {} })).toBe(true);
  });
});

describe('предпочтительный прогон (AD-05a-3, тесты 1–2)', () => {
  it('локальный, затем поздний RDWeb: выбран RDWeb; история линейна', async () => {
    const r = await rev('pdf', 'local');
    const local = await insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), null);
    await completeLocalRun(db.pool, local, [{ kind: 'pdf_page' }], ['Письмо о приостановке']);
    expect(await preferredRunId(db.pool, r.revisionId)).toBe(local);
    const rdweb = await seedRecognition(db.pool, r.revisionId, 'complete');
    const chain = await db.pool.query<{ supersedes_run_id: string }>('SELECT supersedes_run_id FROM recognition_run WHERE id = $1', [rdweb]);
    expect(chain.rows[0]!.supersedes_run_id).toBe(local);
    expect(await preferredRunId(db.pool, r.revisionId)).toBe(rdweb);
  });

  it('RDWeb выше локального, даже если локальный глубже в цепочке; не время создания', async () => {
    const r = await rev('pdf', 'local');
    const rdweb = await seedRecognition(db.pool, r.revisionId, 'complete');
    // Прямой прикладной вызов локальный прогон за RDWeb поставить не может (охранник 0014).
    expect(await sqlCode(insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), s.ids.eng1))).toBe('23514');
    // Состояние «локальный завершился позже RDWeb» создаётся в обход охранника владельцем таблиц —
    // выбор всё равно отдаёт RDWeb (тест 2 решения владельца).
    const owner = new pg.Client({ connectionString: db.migratorUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE recognition_run DISABLE TRIGGER recognition_run_insert_guard');
      const d = descriptorOf('pdf');
      const late = await owner.query<{ id: string }>(
        `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id, created_by, recognizer,
                                      recognizer_fingerprint, recognizer_config_hash)
         VALUES ($1, $2, 'local_ocr', $3, $4, $5, $6::jsonb, local_recognizer_fingerprint($6::jsonb), local_recognizer_config_hash($6::jsonb)) RETURNING id`,
        [r.revisionId, s.tenderA, r.sha, rdweb, s.ids.eng1, JSON.stringify(d)],
      );
      await owner.query('ALTER TABLE recognition_run ENABLE TRIGGER recognition_run_insert_guard');
      await owner.query('COMMIT');
      await completeLocalRun(db.pool, late.rows[0]!.id, [{ kind: 'pdf_page' }], ['Поздний локальный текст']);
    } finally {
      await owner.end();
    }
    expect(await preferredRunId(db.pool, r.revisionId)).toBe(rdweb);
  });

  it('только локальные — глубже по истории; отказы и отмены не выбираются; без успешных — NULL', async () => {
    const r = await rev('docx');
    expect(await preferredRunId(db.pool, r.revisionId)).toBeNull();
    const a = await insertLocalRun(db.pool, r.revisionId, descriptorOf('docx'), null);
    await completeLocalRun(db.pool, a, [{ kind: 'docx_body' }], ['Первый']);
    const b = await insertLocalRun(db.pool, r.revisionId, descriptorOf('docx', { recognizerVersion: '2' }), null);
    await completeLocalRun(db.pool, b, [{ kind: 'docx_body', status: 'needs_review' }], ['Второй']);
    expect(await preferredRunId(db.pool, r.revisionId)).toBe(b);
    const c = await insertLocalRun(db.pool, r.revisionId, descriptorOf('docx', { recognizerVersion: '3' }), null);
    await db.pool.query("UPDATE recognition_run SET status = 'failed', failure_code = 'x', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [c]);
    expect(await preferredRunId(db.pool, r.revisionId)).toBe(b);
  });

  it('снимок принимает только предпочтительный прогон — вторая линия автоподбора', async () => {
    const r = await rev('pdf', 'local');
    const local = await insertLocalRun(db.pool, r.revisionId, descriptorOf('pdf'), null);
    await completeLocalRun(db.pool, local, [{ kind: 'pdf_page' }], ['Локальный текст письма']);
    const rdweb = await seedRecognition(db.pool, r.revisionId, 'complete');
    const set = await setWorkingSet(s.eng1, s.stageA, [r.revisionId], true);
    const content = await db.pool.query<{ content_hash: string }>('SELECT content_hash FROM source_set_revision WHERE id = $1', [set]);
    const make = (runId: string) => {
      const units = [{ unitType: 'document_recognition' as const, documentRevisionId: r.revisionId, recognitionRunId: runId }];
      return createEvidenceScope(db.pool, {
        stageId: s.stageA,
        tenderId: s.tenderA,
        sourceSetRevisionId: set,
        inputVersion: 1,
        contentHash: evidenceScopeContentHash(content.rows[0]!.content_hash, units),
        createdBy: s.ids.eng1,
        units,
      }).then(
        () => 'ok',
        (e: Error) => e.message,
      );
    };
    expect(await make(local)).toContain('предпочтительный прогон');
    expect(await make(rdweb)).toBe('ok');
  });
});
