// R05a-01 (Review 05a-1): размеры физической страницы PDF обязательны при любом статусе (AD-05a-1,
// интерпретация 13). Миграция 0015: CHECK recognition_page_unit_shape требует размеры у pdf_page при любом
// статусе, кроме missing; охранник вставки требует их у страницы PDF локального прогона и при missing.
// Исключение — страница RDWeb, которой нет в экспорте (этап 04, R04-03): missing без размеров, как было.
// Регрессии 1–7 ревью — прямыми вставками под ролью приложения; затем штатный конвейер PDF (адаптер и
// worker) пишет размеры у слабого текстового слоя, нечитаемого OCR и недоступного OCR; обновление 0014 → 0015.
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_LIMITS, recognizeLocal, type ILocalOcrEngineFactory, type ILocalRunOptions } from '../packages/adapters/src/index.ts';
import { createPool, dropDatabase, listMigrations, migrate, MIGRATIONS_DIR, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { HANDLERS } from '../apps/worker/src/handlers/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { ADMIN_URL, buildScenario, createTestDb, createUser, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import * as fx from './localFixtures.ts';
import { descriptorOf, insertLocalRun, newRevision, sqlCode, startRunSql } from './localRecognitionFixtures.ts';

const STATUSES = ['recognized', 'needs_review', 'missing', 'failed'] as const;
const pdf = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', 'local', `${name}.pdf`));

// Одна страница A4 со слабым текстовым слоем: «Page 1» стандартным шрифтом Helvetica — меньше порога
// пригодного текста (20 символов, 3 слова), но не пусто.
const weakTextPdf = (): Buffer => {
  const content = 'BT /F1 24 Tf 72 720 Td (Page 1) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
};

// Подставной OCR: мусор с низкой уверенностью — страница нечитаема (ocr_unreadable).
const garbageOcr: ILocalOcrEngineFactory = {
  describe: async () => ({ engineId: 'fake-garbage', engineVersion: '0', coreVersion: '0', oem: 'x', engineLanguages: 'rus+eng', models: [] }),
  create: async () => ({
    recognize: async () => {
      const text = 'lIl1 ,.; rnm IIl| ~~ 0O0 ,,, ||l1 rnrn';
      return { text, blocks: [{ text, confidence: 12 }], confidence: 12, words: 8 };
    },
    close: async () => undefined,
  }),
};

const adapterRun = (bytes: Buffer, o: Partial<ILocalRunOptions> = {}) =>
  recognizeLocal({ format: 'pdf', bytes, limits: DEFAULT_LOCAL_LIMITS, ocr: null, ocrDpi: 200, ocrPageTimeoutMs: 60_000, throwIfStopped: () => undefined, ...o });

describe('R05a-01: размеры страницы PDF в БД', () => {
  let db: ITestDb;
  let s: IScenario;
  beforeAll(async () => {
    db = await createTestDb();
    s = await buildScenario(db, makeApp(db, undefined, testConfig()));
  });
  afterAll(async () => db.drop());

  const running = async (format: 'pdf' | 'xlsx' | 'csv' | 'docx') => {
    const r = await newRevision(db.pool, { tenderId: s.tenderA, format, route: 'local', userId: s.ids.eng1 });
    const run = await insertLocalRun(db.pool, r.revisionId, descriptorOf(format), s.ids.eng1);
    await startRunSql(db.pool, run);
    return run;
  };
  // Код отказа и то, что отказало: CHECK (имя ограничения) или охранник вставки (R05a-01 в сообщении).
  const insert = (run: string, index: number, kind: string, status: string, sized: boolean) =>
    db.pool
      .query('INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, $2, $3, $4, $5, 0, $6)', [
        run,
        index,
        kind,
        sized ? 1654 : null,
        sized ? 2339 : null,
        status,
      ])
      .then(
        () => 'ok',
        (e: { code?: string; constraint?: string; message: string }) =>
          `${e.code}:${e.constraint ?? (e.message.includes('R05a-01') ? 'guard' : 'other')}`,
      );

  it('1–4: страница PDF локального прогона без размеров — отказ при любом статусе', async () => {
    const run = await running('pdf');
    // Все четыре исхода сразу: на схеме 0014 здесь recognized — отказ CHECK, остальные три — «ok».
    const got: Record<string, string> = {};
    for (const [i, status] of STATUSES.entries()) got[status] = await insert(run, i, 'pdf_page', status, false);
    expect(got).toEqual({ recognized: '23514:guard', needs_review: '23514:guard', missing: '23514:guard', failed: '23514:guard' });
  });

  it('5: с размерами допустимы все четыре статуса локальной страницы PDF', async () => {
    const run = await running('pdf');
    for (const [i, status] of STATUSES.entries()) {
      expect(await insert(run, i, 'pdf_page', status, true), status).toBe('ok');
    }
  });

  // Выполняющийся прогон заданного нелокального движка прямой записью под ролью приложения: rdweb_api и
  // text_layer нормативный API сейчас не создаёт, но схема их допускает (Review 05a-2).
  const runningOf = async (engine: 'rdweb_export' | 'rdweb_api' | 'text_layer') => {
    const r = await newRevision(db.pool, { tenderId: s.tenderA, format: 'pdf', userId: s.ids.eng1 });
    const zip = randomBytes(32).toString('hex');
    await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [zip, `r/${zip}`]);
    const run = (
      await db.pool.query<{ id: string }>(
        'INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256) VALUES ($1, $2, $3, $4) RETURNING id',
        [r.revisionId, s.tenderA, engine, zip],
      )
    ).rows[0]!.id;
    await startRunSql(db.pool, run);
    return run;
  };

  it('Review 05a-2: страница PDF без размеров допустима только у rdweb_export в статусе missing', async () => {
    const got: Record<string, string> = {};
    for (const engine of ['rdweb_export', 'rdweb_api', 'text_layer'] as const) {
      const run = await runningOf(engine);
      for (const [i, status] of (['missing', 'recognized', 'failed'] as const).entries()) got[`${engine} ${status}`] = await insert(run, i, 'pdf_page', status, false);
    }
    got['local_ocr missing'] = await insert(await running('pdf'), 0, 'pdf_page', 'missing', false);
    // На схеме e92486e (0015) здесь «ok» были ещё rdweb_api missing и text_layer missing.
    expect(got).toEqual({
      'rdweb_export missing': 'ok',
      'rdweb_export recognized': '23514:guard',
      'rdweb_export failed': '23514:guard',
      'rdweb_api missing': '23514:guard',
      'rdweb_api recognized': '23514:guard',
      'rdweb_api failed': '23514:guard',
      'text_layer missing': '23514:guard',
      'text_layer recognized': '23514:guard',
      'text_layer failed': '23514:guard',
      'local_ocr missing': '23514:guard',
    });
  });

  it('те же движки с размерами допустимы; needs_review у нелокального движка — по-прежнему отказ', async () => {
    for (const engine of ['rdweb_export', 'rdweb_api', 'text_layer'] as const) {
      const run = await runningOf(engine);
      expect(await insert(run, 0, 'pdf_page', 'missing', true), engine).toBe('ok');
      expect(await insert(run, 1, 'pdf_page', 'recognized', true), engine).toBe('ok');
      expect(await insert(run, 2, 'pdf_page', 'failed', true), engine).toBe('ok');
      expect(await insert(run, 3, 'pdf_page', 'needs_review', true), engine).toBe('23514:other');
    }
  });

  it('CHECK остаётся общей второй линией: без охранника pdf_page без размеров — только missing', async () => {
    const run = await runningOf('rdweb_export');
    const owner = new pg.Client({ connectionString: db.migratorUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE recognition_page DISABLE TRIGGER recognition_page_unit_guard');
      const code = (status: string, i: number) =>
        owner
          .query('SAVEPOINT p')
          .then(() =>
            owner.query("INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, $2, 'pdf_page', NULL, NULL, 0, $3)", [
              run,
              i,
              status,
            ]),
          )
          .then(
            () => 'ok',
            async (e: { code?: string; constraint?: string }) => {
              await owner.query('ROLLBACK TO SAVEPOINT p');
              return `${e.code}:${e.constraint}`;
            },
          );
      expect(await code('recognized', 0)).toBe('23514:recognition_page_unit_shape');
      expect(await code('failed', 0)).toBe('23514:recognition_page_unit_shape');
      expect(await code('missing', 0)).toBe('ok');
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
  });

  it('6–7: у логической единицы размеров нет — с размерами отказ, без размеров PASS', async () => {
    for (const [format, kind] of [
      ['xlsx', 'xlsx_sheet'],
      ['csv', 'csv_table'],
      ['docx', 'docx_body'],
    ] as const) {
      const run = await running(format);
      expect(await insert(run, 0, kind, 'recognized', true), kind).toBe('23514:recognition_page_unit_shape');
      expect(await insert(run, 0, kind, 'needs_review', true), kind).toBe('23514:recognition_page_unit_shape');
      expect(await insert(run, 0, kind, 'recognized', false), kind).toBe('ok');
      expect(await insert(run, 1, kind, 'needs_review', false), kind).toBe('ok');
    }
  });
});

describe('R05a-01: штатный конвейер PDF пишет размеры страницы при любом исходе', () => {
  it('адаптер: слабый текстовый слой, нечитаемый OCR, OCR не настроен, OCR не нашёл текста', async () => {
    const weak = await adapterRun(weakTextPdf());
    expect(weak.units[0]).toMatchObject({ kind: 'pdf_page', status: 'needs_review', issues: ['text_layer_insufficient', 'ocr_unavailable'] });
    const unreadable = await adapterRun(pdf('mixed'), { ocr: garbageOcr });
    expect(unreadable.units[1]).toMatchObject({ status: 'failed', issues: ['text_layer_insufficient', 'ocr_unreadable'] });
    const unavailable = await adapterRun(pdf('letter-scan'));
    expect(unavailable.units[0]).toMatchObject({ status: 'missing', issues: ['ocr_unavailable'] });
    for (const u of [weak.units[0]!, unreadable.units[1]!, unavailable.units[0]!]) {
      expect(u.widthPx, u.status).toBeGreaterThan(0);
      expect(u.heightPx, u.status).toBeGreaterThan(0);
    }
    // A4 (595 × 842 pt) при 200 dpi.
    expect([weak.units[0]!.widthPx, weak.units[0]!.heightPx]).toEqual([1653, 2339]);
  });

  describe('worker → БД', () => {
    let db: ITestDb;
    let s: IScenario;
    const config = testConfig();
    beforeAll(async () => {
      db = await createTestDb();
      s = await buildScenario(db, makeApp(db, undefined, config));
    });
    afterAll(async () => db.drop());

    // Загрузка штатным импортом и политика документа «локально» (OD-1).
    const uploadLocal = async (worker: WorkerRuntime, name: string, body: Buffer): Promise<string> => {
      const up = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent(name)}`, body, {
        headers: { 'Content-Type': 'application/octet-stream', ...idem() },
      });
      expect(up.status, up.text).toBe(202);
      await drain(worker);
      const rev = (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
      const doc = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items.find((d: { latestRevisionId: string }) => d.latestRevisionId === rev);
      const patch = await s.eng1.patch(`/documents/${doc.id}`, { recognitionRoute: 'local' }, { headers: { 'If-Match': `"${doc.id}:${doc.rowVersion}"` } });
      expect(patch.status, patch.text).toBe(200);
      return rev;
    };
    const pagesOf = async (revisionId: string) => {
      const run = await db.pool.query<{ id: string; status: string; quality: { units: { index: number; issues: string[] }[] } }>(
        "SELECT id, status, quality FROM recognition_run WHERE document_revision_id = $1 AND engine = 'local_ocr'",
        [revisionId],
      );
      expect(run.rows).toHaveLength(1);
      const pages = await db.pool.query<{ page_index: number; status: string; width_px: number | null; height_px: number | null }>(
        'SELECT page_index, status, width_px, height_px FROM recognition_page WHERE run_id = $1 ORDER BY page_index',
        [run.rows[0]!.id],
      );
      return { run: run.rows[0]!, pages: pages.rows.map((p) => ({ ...p, issues: run.rows[0]!.quality.units[p.page_index]!.issues })) };
    };

    it('нечитаемый OCR, недоступный OCR и слабый текстовый слой — страницы записаны с размерами', async () => {
      const fakeWorker = new WorkerRuntime({
        pool: db.pool,
        store: new BlobStore(config.storageRoot),
        config,
        handlers: HANDLERS,
        workerId: 'garbage-ocr',
        embeddings: null,
        localOcr: garbageOcr,
      });
      const unreadable = await uploadLocal(fakeWorker, 'Смешанный-мусор.pdf', fx.uniqueCopy(pdf('mixed'), 'pdf'));
      await fakeWorker.scheduleLocalRecognition();
      await drain(fakeWorker);
      const a = await pagesOf(unreadable);
      expect(a.run.status).toBe('partial');
      expect(a.pages[1]).toMatchObject({ status: 'failed', issues: ['text_layer_insufficient', 'ocr_unreadable'] });

      // Worker без OCR (настройка тестов по умолчанию).
      const worker = makeWorker(db, config);
      const unavailable = await uploadLocal(worker, 'Смешанный-без-OCR.pdf', fx.uniqueCopy(pdf('mixed'), 'pdf'));
      const weak = await uploadLocal(worker, 'Слабый-слой.pdf', weakTextPdf());
      await worker.scheduleLocalRecognition();
      await drain(worker);
      const b = await pagesOf(unavailable);
      expect(b.run.status).toBe('partial');
      expect(b.pages[1]).toMatchObject({ status: 'missing', issues: ['ocr_unavailable'] });
      const c = await pagesOf(weak);
      expect(c.run.status).toBe('partial');
      expect(c.pages[0]).toMatchObject({ status: 'needs_review', issues: ['text_layer_insufficient', 'ocr_unavailable'] });

      for (const p of [...a.pages, ...b.pages, ...c.pages]) {
        expect(p.width_px, `${p.status} ${p.issues.join(',')}`).toBeGreaterThan(0);
        expect(p.height_px, `${p.status} ${p.issues.join(',')}`).toBeGreaterThan(0);
      }
    });
  });
});

describe('R05a-01: обновление схемы 0014 → 0015 → 0016', () => {
  const dbs: { name: string; pool: Pool }[] = [];
  afterAll(async () => {
    for (const d of dbs) {
      await d.pool.end();
      await dropDatabase(ADMIN_URL, d.name);
    }
  });
  const urlFor = (name: string, user: string): string => {
    const u = new URL(ADMIN_URL);
    u.username = user;
    u.password = '';
    u.pathname = `/${name}`;
    return u.toString();
  };
  const withMigrator = async <T>(name: string, fn: (m: pg.Client) => Promise<T>): Promise<T> => {
    const m = new pg.Client({ connectionString: urlFor(name, 'kontur_migrator') });
    await m.connect();
    try {
      return await fn(m);
    } finally {
      await m.end();
    }
  };
  // База на схеме upTo (0014 — передача 86c0e15, 0015 — передача e92486e) с тендером, пользователем и
  // прогоном RDWeb этапа 04: страница 1 распознана, страницы 2 в экспорте нет — missing без размеров.
  const atSchema = async (upTo: 14 | 15, tag: string) => {
    const name = `kontur_kp_test_r05a01_${upTo}_${tag}_${Date.now().toString(36)}`;
    await setupDatabase(ADMIN_URL, name);
    const dir = mkdtempSync(join(tmpdir(), 'kontur-r05a01-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= upTo)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    expect(await withMigrator(name, (m) => migrate(m, { testMode: true, dir }))).toHaveLength(upTo);
    const pool = createPool(urlFor(name, 'kontur_app'), 3);
    dbs.push({ name, pool });
    const eng = await createUser(pool, 'eng1', ['engineer'], 'Инженер');
    const tender = (await pool.query<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('R5A', 'Тендер R5A', $1) RETURNING id", [eng])).rows[0]!.id;
    const rd = await newRevision(pool, { tenderId: tender, format: 'pdf', userId: eng });
    const zip = randomBytes(32).toString('hex');
    await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/zip', $2)", [zip, `m/${zip}`]);
    const rdRun = (
      await pool.query<{ id: string }>(
        "INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256) VALUES ($1, $2, 'rdweb_export', $3) RETURNING id",
        [rd.revisionId, tender, zip],
      )
    ).rows[0]!.id;
    await startRunSql(pool, rdRun);
    await pool.query(
      `INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status)
       VALUES ($1, 0, '1', 2480, 3508, 0, 'recognized'), ($1, 1, '2', NULL, NULL, 0, 'missing')`,
      [rdRun],
    );
    await pool.query(
      "UPDATE recognition_run SET status = 'partial', engine_schema_version = '1', pages_total = 2, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [rdRun],
    );
    const local = await newRevision(pool, { tenderId: tender, format: 'pdf', route: 'local', userId: eng });
    const localRun = await insertLocalRun(pool, local.revisionId, descriptorOf('pdf'), eng);
    await startRunSql(pool, localRun);
    // Выполняющийся прогон нелокального движка той же схемы — прямой записью (Review 05a-2).
    const runOf = async (engine: 'rdweb_api' | 'text_layer'): Promise<string> => {
      const r = await newRevision(pool, { tenderId: tender, format: 'pdf', userId: eng });
      const z = randomBytes(32).toString('hex');
      await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/zip', $2)", [z, `m/${z}`]);
      const id = (
        await pool.query<{ id: string }>(
          'INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256) VALUES ($1, $2, $3, $4) RETURNING id',
          [r.revisionId, tender, engine, z],
        )
      ).rows[0]!.id;
      await startRunSql(pool, id);
      return id;
    };
    return { name, pool, localRun, runOf };
  };
  const LATEST = listMigrations().at(-1)!.version;
  const version = async (pool: Pool): Promise<number> =>
    (await pool.query<{ v: number }>('SELECT max(version)::int AS v FROM schema_migration')).rows[0]!.v;

  it('данные этапов 04–05a с размерами и RDWeb-страница без размеров переживают 0015 и 0016; ограничения проверены', async () => {
    const d = await atSchema(14, 'ok');
    for (const [i, status] of STATUSES.entries()) {
      await d.pool.query('INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, $2, $3, 1654, 2339, 0, $4)', [
        d.localRun,
        i,
        'pdf_page',
        status,
      ]);
    }
    const pagesBefore = (await d.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM recognition_page')).rows[0]!.n;
    await withMigrator(d.name, async (m) => {
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 14).map((f) => f.version));
      const invalid = await m.query("SELECT conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace");
      expect(invalid.rows).toEqual([]);
    });
    expect((await d.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM recognition_page')).rows[0]!.n).toBe(pagesBefore);
    expect(await version(d.pool)).toBe(LATEST);
  });

  it('локальная страница PDF без размеров, записанная на 0014, не даёт применить 0015: needs_review — CHECK, missing — проверка миграции', async () => {
    for (const status of ['needs_review', 'missing'] as const) {
      const d = await atSchema(14, status);
      await d.pool.query("INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, 0, 'pdf_page', NULL, NULL, 0, $2)", [
        d.localRun,
        status,
      ]);
      const failure = await withMigrator(d.name, (m) => migrate(m, { testMode: true }).then(() => 'применена', (e: Error) => e.message));
      expect(failure, status).toMatch(status === 'missing' ? /R05a-01/u : /recognition_page_unit_shape/u);
      expect(await version(d.pool)).toBe(14);
    }
  });

  it('Review 05a-2: 0015 → 0016 сохраняет исторический rdweb_export missing без размеров', async () => {
    const d = await atSchema(15, 'rdweb');
    const kept = "SELECT count(*)::int AS n FROM recognition_page p JOIN recognition_run r ON r.id = p.run_id WHERE r.engine = 'rdweb_export' AND p.status = 'missing' AND p.width_px IS NULL";
    expect((await d.pool.query<{ n: number }>(kept)).rows[0]!.n).toBe(1);
    await withMigrator(d.name, async (m) => {
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 15).map((f) => f.version));
    });
    expect((await d.pool.query<{ n: number }>(kept)).rows[0]!.n).toBe(1);
    expect(await version(d.pool)).toBe(LATEST);
  });

  it('Review 05a-2: страница text_layer или rdweb_api missing без размеров, записанная на 0015, не даёт применить 0016', async () => {
    for (const engine of ['text_layer', 'rdweb_api'] as const) {
      const d = await atSchema(15, engine);
      const run = await d.runOf(engine);
      // На 0015 такая строка принималась: CHECK разрешал missing, охранник проверял только local_ocr.
      await d.pool.query("INSERT INTO recognition_page (run_id, page_index, unit_kind, width_px, height_px, rotation, status) VALUES ($1, 0, 'pdf_page', NULL, NULL, 0, 'missing')", [run]);
      const failure = await withMigrator(d.name, (m) => migrate(m, { testMode: true }).then(() => 'применена', (e: Error) => e.message));
      expect(failure, engine).toMatch(/0016.*rdweb_export \+ missing/u);
      expect(await version(d.pool), engine).toBe(15);
    }
  });
});
