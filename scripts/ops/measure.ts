// npm run ops:measure -- --positions <N> --lines <на позицию> --docs <текстовых PDF> --scans <сканов> [--queries 20]
//                        [--md-mb <МБ> [--md-doc-mb 5] [--md-page-kb 3]] [--profile <имя>] [--real-model] [--out <журнал>]
// Профиль D-040: --positions 10000 --lines 3 --md-mb 1024 — 10 000 позиций, ~30 000 строк, до 1 ГБ Markdown:
// документы с экспортом RDWeb (настоящий PDF + `_results.md`, scripts/ops/measure-corpus.ts). Корпус готовится на
// диске до замеров; время подготовки в замеры не входит.
// Замеры этапа 17 (проект §13.3) на настоящих server и worker и синтетическом тендере заданного размера: выгрузка
// расчёта (поддельный TenderHub, N позиций × строки), импорт архива документов, локальное распознавание (текстовый
// слой и OCR сканов), сборка индекса и векторов, поиск p50/p95, прогон проверки этапа, сборка комплекта с превью
// LibreOffice, копия ops:backup. Числа владельца — В-17-1. Модель и эмбеддинги — поддельные (синтетический замер);
// --real-model берёт настроенный сервер модели из окружения (LM Studio на целевом ПК): оба провайдера обязаны быть
// openai_compatible, иначе замер не выполняется (R17-06). Успех поиска — по итогу каждого запроса и всех веток (R17-07,
// scripts/ops/measure-lib.ts). Журнал — artifacts/stage-17/measure-<профиль>.log с фактами среды. Прогон на машине
// разработки — проверка сценария, для SLO не годится. --db <kontur_…> — имя временной базы замера.
// База замера — только своя (R17-09): существующую базу с этим именем замер не трогает и не выполняется; удаляет
// только базу, которую создал сам и пометил меткой запуска, — и после итога, и после отказа шага или Ctrl+C.
// Код выхода: 0 — все замеры выполнены, 1 — какой-то шаг не выполнен или замер прерван, 3 — замер не выполнялся:
// живой замер невозможен при этой настройке или база замера уже существует.
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem, type } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildId } from '../../packages/config/src/index.ts';
import { setupDatabase } from '../../packages/db/src/index.ts';
import { fakeItem, fakePosition, fakeTender, n, TH_KEY } from '../tenderhub-fake-data.ts';
import { startFakeTenderHub } from '../tenderhub-fake.ts';
import { buildZip } from '../../tests/zip.ts';
import { mdCorpusPlan, mdExport, mdPdf, type IMdDoc } from './measure-corpus.ts';
import { argValue, hasFlag } from '../cli.ts';
import { indexModelProblem, modelSetup, searchOutcome, summarizeSearch, type ISearchOutcome, type ISearchRunView } from './measure-lib.ts';
import { ApiClient, freePort, sleep, startNode, stopNode, waitReady, type IProc } from './procs.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
// Шаги smoke этапов 11 и 12 (JavaScript без типов) — динамической загрузкой.
type SmokeStep = (o: Record<string, unknown>) => Promise<{ candidateId?: string } | undefined>;
const smokeStep = async (file: string, name: string): Promise<SmokeStep> => ((await import(pathToFileURL(join(ROOT, 'scripts', file)).href)) as Record<string, SmokeStep>)[name]!;
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = argValue('db') ?? 'kontur_kp_measure_test';
if (!/^kontur_[a-z0-9_]{1,50}$/u.test(DB)) throw new Error('--db: имя вида kontur_<строчные латинские, цифры, _>');
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const num = (name: string, def: number): number => Number(argValue(name) ?? def);
const P = { positions: num('positions', 93), lines: num('lines', 25), docs: num('docs', 20), scans: num('scans', 3), queries: num('queries', 20) };
const MD = { mb: num('md-mb', 0), docMb: num('md-doc-mb', 5), pageKb: num('md-page-kb', 3) };
const PROFILE = argValue('profile') ?? 'dev';
const REAL_MODEL = hasFlag('real-model');

const lines: string[] = [];
let failed = false;
let notRun = false;
// Метка своей базы: комментарий базы, созданной этим запуском. Удаляется только база с этой меткой.
const RUN_MARK = `kontur-measure:${randomUUID()}`;
let ownDb = false;
let interrupted = false;
const procs: IProc[] = [];
// Временные каталоги этого запуска (хранилище, копия, корпус профиля md): создал — удаляет.
const tempDirs: string[] = [];
let hubClose: (() => Promise<void>) | null = null;
const record = (step: string, ms: number | null, note = ''): void => {
  if (ms === null) failed = true;
  const line = `${ms === null ? 'FAIL   ' : `${(ms / 1000).toFixed(1).padStart(7)} с`}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
};
const info = (line: string): void => {
  lines.push(`# ${line}`);
  console.log(`# ${line}`);
};

const dbUrl = (user: string): string => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = '';
  u.pathname = `/${DB}`;
  return u.toString();
};
const admin = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], db = DB): Promise<pg.QueryResult<T>> => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: u.toString() });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await c.query<T>(sql, params);
  } finally {
    await c.end();
  }
};
const waitFor = async <T>(fn: () => Promise<T | null>, timeoutMs: number, stepMs = 500): Promise<T | null> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};
const timed = async <T>(fn: () => Promise<T | null>): Promise<{ ms: number | null; value: T | null }> => {
  const t0 = Date.now();
  const value = await fn();
  return { ms: value === null ? null : Date.now() - t0, value };
};
// Ответ команды с ожидаемым кодом — иначе замер прерывается сразу и с причиной, а не ждёт до тайм-аута.
const expectStatus = async (r: Response, ok: number[], what: string): Promise<Response> => {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
};
const unique = (file: string): Buffer => Buffer.concat([readFileSync(file), Buffer.from(`\n%kontur-measure-${randomBytes(6).toString('hex')}\n`)]);

const generatedTender = (id: string) => {
  const positions = [];
  const items = [];
  for (let i = 1; i <= P.positions; i += 1) {
    const pid = randomUUID();
    positions.push(fakePosition(id, pid, { position_number: n(String(i)), work_name: `Работа ${i}: устройство конструкций секции ${1 + (i % 7)}`, items_count: n(String(P.lines)) }));
    for (let j = 1; j <= P.lines; j += 1) {
      items.push(fakeItem(id, pid, randomUUID(), { boq_item_type: j === 1 ? 'раб' : 'мат', sort_number: n(String(j)), quantity: n(String(j)), unit_rate: n('125.50'), total_amount: n(String((125.5 * j).toFixed(2))) }));
    }
  }
  return fakeTender({ id, tender_number: `MEASURE-${P.positions}`, version: 1, positions, items });
};

const main = async (): Promise<void> => {
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true });
  info(`Замеры этапа 17 — ${new Date().toISOString()}, профиль «${PROFILE}»${PROFILE === 'dev' ? ' (машина разработки: для SLO не годится)' : ''}`);
  info(`Среда: ${hostname()}, ${type()} ${release()}, CPU ${cpus()[0]?.model.trim()} × ${cpus().length}, ОЗУ ${(totalmem() / 1024 ** 3).toFixed(1)} ГБ, GPU ${gpu.status === 0 ? gpu.stdout.trim() : 'нет'}, Node ${process.version}, сборка ${buildId() ?? '—'}`);
  info(`Размер: позиций ${P.positions}, строк расчёта ${P.positions * P.lines}, текстовых документов ${P.docs}, сканов ${P.scans}, Markdown ${MD.mb} МБ, запросов поиска ${P.queries}`);
  const hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hubClose = () => hub.close();
  const tenderId = randomUUID();
  hub.tenders.set(tenderId, generatedTender(tenderId));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const storage = mkdtempSync(join(tmpdir(), 'kontur-measure-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'kontur-measure-backup-'));
  tempDirs.push(storage, backupRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KONTUR_ENV: 'test',
    DATABASE_ADMIN_URL: ADMIN,
    DATABASE_URL: dbUrl('kontur_app'),
    DATABASE_MIGRATOR_URL: dbUrl('kontur_migrator'),
    BACKUP_DATABASE_URL: dbUrl('kontur_backup'),
    STORAGE_ROOT: storage,
    BACKUP_ROOT: backupRoot,
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    ALLOWED_ORIGINS: base,
    TENDERHUB_URL: hub.url,
    TENDERHUB_API_KEY: TH_KEY,
    TENDERHUB_INSTANCE_ID: 'th-measure',
    ...(REAL_MODEL ? {} : { MODEL_PROVIDER: 'fake', EMBEDDING_PROVIDER: 'fake', EMBEDDING_DIM: '16' }),
  };
  for (const k of ['TLS_CERT_FILE', 'TLS_KEY_FILE', 'INTAKE_ROOTS']) delete env[k];
  const node = (args: string[], input?: string) => spawnSync(process.execPath, args, { cwd: ROOT, env, input, encoding: 'utf8' });
  // Модель — по той же конфигурации, что получат server и worker, а не по флагу (R17-06).
  const setup = modelSetup(env, REAL_MODEL);
  info(`Модель: ${setup.identity}`);
  try {
    if (setup.refusal.length > 0) {
      notRun = true;
      for (const r of setup.refusal) info(`НЕ ВЫПОЛНЕНО: ${r}`);
      return;
    }
    if (setup.live) info('генеративная модель в этих замерах отдельно не проверяется: её живая проверка — npm run model:live-smoke');
    // Своя база (R17-09): существующую — чужую или оставшуюся от другого запуска — замер не трогает.
    if ((await admin('SELECT 1 FROM pg_database WHERE datname = $1', [DB], 'postgres')).rowCount) {
      notRun = true;
      info(`НЕ ВЫПОЛНЕНО: база ${DB} уже существует — замер работает только в созданной им базе и чужую не удаляет; удалите её вручную или задайте другое --db`);
      return;
    }
    const created = await setupDatabase(ADMIN, DB, {
      appPassword: process.env.KONTUR_APP_DB_PASSWORD,
      migratorPassword: process.env.KONTUR_MIGRATOR_DB_PASSWORD,
      backupPassword: process.env.KONTUR_BACKUP_DB_PASSWORD,
    });
    if (created !== 'created') throw new Error(`база ${DB} появилась во время подготовки — замер её не трогает`);
    await admin(`COMMENT ON DATABASE ${DB} IS '${RUN_MARK}'`, [], 'postgres');
    ownDb = true;
    if (node(['scripts/db-migrate.ts']).status !== 0 || node(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD).status !== 0) {
      throw new Error('подготовка БД не удалась');
    }
    procs.push(startNode('worker', 'apps/worker/src/main.ts', { cwd: ROOT, env }), startNode('server', 'apps/server/src/main.ts', { cwd: ROOT, env }));
    if (!(await waitReady(base, 60_000)).ok) throw new Error('server и worker не готовы');
    const api = new ApiClient(base, base);
    const api2 = new ApiClient(base, base);
    await api.call('/auth/login', { method: 'POST', body: { login: 'demo.eng1', password: PASSWORD } });
    await api2.call('/auth/login', { method: 'POST', body: { login: 'demo.manager', password: PASSWORD } });
    // Связь этапа с тендером TenderHub — право администратора (admin.tender).
    const adminApi = new ApiClient(base, base);
    await adminApi.call('/auth/login', { method: 'POST', body: { login: 'demo.admin', password: PASSWORD } });
    const demo = ((await (await api.call('/tenders')).json()) as { items: Array<{ id: string; code: string }> }).items.find((t) => t.code === 'DEMO-001')!;
    const stageId = ((await (await api.call(`/tenders/${demo.id}/stages`)).json()) as { items: Array<{ id: string }> }).items[0]!.id;
    const key = () => ({ 'Idempotency-Key': `measure-${randomBytes(6).toString('hex')}` });

    // ---- Выгрузка расчёта TenderHub
    // Администратор назначается руководителем тендера (как в установке): связь источника — по тендеру, где он участник.
    const me = (await (await adminApi.call('/me')).json()) as { id?: string; user?: { id: string } };
    const tenderView = await adminApi.call(`/tenders/${demo.id}`);
    await expectStatus(
      await adminApi.call(`/tenders/${demo.id}/members/${me.user?.id ?? me.id}`, { method: 'PUT', headers: { 'If-Match': tenderView.headers.get('etag') ?? '', ...key() }, body: { memberRole: 'manager' } }),
      [200, 201],
      'назначение администратора на тендер',
    );
    const src = await adminApi.call(`/stages/${stageId}/calculation-source`);
    await expectStatus(
      await adminApi.call(`/stages/${stageId}/calculation-source`, { method: 'PUT', headers: { 'If-Match': src.headers.get('etag') ?? '' }, body: { externalTenderId: tenderId, externalVersion: 1 } }),
      [200],
      'связь этапа с TenderHub',
    );
    const cap = await timed(async () => {
      const c = (await (await expectStatus(await api.call(`/stages/${stageId}/calculation-captures`, { method: 'POST', body: {}, headers: key() }), [202], 'выгрузка расчёта')).json()) as { id: string };
      return waitFor(async () => {
        const r = (await (await api.call(`/calculation-captures/${c.id}`)).json()) as { status: string };
        return r.status === 'complete' ? r : null;
      }, 30 * 60_000);
    });
    record(`выгрузка расчёта: ${P.positions} позиций, ${P.positions * P.lines} строк`, cap.ms);

    // ---- Импорт архива документов
    const entries = [
      ...Array.from({ length: P.docs }, (_, i) => ({ name: `Том-${i + 1}.pdf`, data: unique(join(ROOT, 'tests', 'fixtures', 'local', 'letter-text.pdf')) })),
      ...Array.from({ length: P.scans }, (_, i) => ({ name: `Скан-${i + 1}.pdf`, data: unique(join(ROOT, 'tests', 'fixtures', 'local', 'letter-scan.pdf')) })),
    ];
    const zip = buildZip(entries);
    const imp = await timed(async () => {
      const up = (await (await expectStatus(await api.call(`/stages/${stageId}/imports?name=measure.zip`, { method: 'POST', raw: zip, headers: key() }), [202], 'импорт')).json()) as { id: string };
      return waitFor(async () => {
        const b = (await (await api.call(`/imports/${up.id}`)).json()) as { status: string; items: Array<{ documentRevisionId: string | null }> };
        return b.status === 'completed' ? b : null;
      }, 60 * 60_000);
    });
    record(`импорт архива: ${entries.length} файлов, ${(zip.length / 1024 ** 2).toFixed(1)} МБ`, imp.ms);
    const revisions = (imp.value?.items ?? []).map((i) => i.documentRevisionId).filter((x): x is string => Boolean(x));

    // ---- Локальное распознавание: текстовый слой и OCR сканов
    const recog = await timed(async () => {
      const runs: string[] = [];
      for (const rev of revisions) {
        const r = (await (await expectStatus(await api.call(`/document-revisions/${rev}/local-recognitions`, { method: 'POST', body: {}, headers: key() }), [202], 'локальное распознавание')).json()) as { run?: { id: string } };
        if (r.run?.id) runs.push(r.run.id);
      }
      return waitFor(async () => {
        const q = await admin<{ n: number }>("SELECT count(*)::int AS n FROM recognition_run WHERE id = ANY($1::uuid[]) AND status IN ('complete', 'partial', 'failed')", [runs]);
        return q.rows[0]!.n === runs.length ? runs : null;
      }, 6 * 60 * 60_000, 2000);
    });
    record(`локальное распознавание: ${revisions.length} документов (сканов OCR — ${P.scans})`, recog.ms);
    const ocr = await admin<{ ms: number | null }>(
      "SELECT round(avg((quality -> 'timings' ->> 'totalMs')::numeric))::int AS ms FROM recognition_run WHERE engine = 'local_ocr' AND status = 'complete' AND quality -> 'recognizer' ->> 'processing' LIKE '%ocr%'",
    ).catch(() => ({ rows: [{ ms: null }] }));
    if (ocr.rows[0]?.ms) info(`OCR одного скана (страница letter-scan, 300 dpi): в среднем ${(ocr.rows[0].ms / 1000).toFixed(1)} с`);

    // ---- Профиль D-040: распознанный текст в Markdown — оригиналы PDF и экспорт RDWeb
    if (MD.mb > 0) {
      const plan = mdCorpusPlan({ totalMb: MD.mb, docMb: MD.docMb, pageKb: MD.pageKb });
      const pagesTotal = plan.reduce((a, d) => a + d.pages, 0);
      // Подготовка на диске до замеров: генерация текста не входит во время импорта.
      const corpusDir = mkdtempSync(join(tmpdir(), 'kontur-measure-md-'));
      tempDirs.push(corpusDir);
      let mdBytes = 0;
      const prep = Date.now();
      for (const d of plan) {
        // Подготовка 1 ГБ идёт минуты: между документами остановка успевает сработать (R17-10).
        await new Promise((r) => setImmediate(r));
        if (interrupted) throw new Error('замер остановлен');
        writeFileSync(join(corpusDir, `${d.index}.pdf`), mdPdf(d));
        const exp = mdExport(d, MD.pageKb);
        mdBytes += exp.mdBytes;
        writeFileSync(join(corpusDir, `${d.index}.zip`), exp.zip);
      }
      info(`профиль md: ${plan.length} документов, ${pagesTotal} страниц, Markdown ${(mdBytes / 1024 ** 2).toFixed(0)} МБ; подготовка корпуса ${((Date.now() - prep) / 1000).toFixed(0)} с (в замеры не входит)`);
      try {
        const originals = await timed(async () => {
          const batches: Array<{ doc: IMdDoc; batch: string }> = [];
          for (const d of plan) {
            const up = await expectStatus(await api.call(`/stages/${stageId}/imports?name=${encodeURIComponent(`${d.name}.pdf`)}`, { method: 'POST', raw: readFileSync(join(corpusDir, `${d.index}.pdf`)), headers: key() }), [202], 'импорт оригинала');
            batches.push({ doc: d, batch: ((await up.json()) as { id: string }).id });
          }
          const revs: Array<{ doc: IMdDoc; revision: string }> = [];
          for (const b of batches) {
            const done = await waitFor(async () => {
              const v = (await (await api.call(`/imports/${b.batch}`)).json()) as { status: string; items: Array<{ documentRevisionId: string | null }> };
              return v.status === 'completed' ? v : null;
            }, 6 * 60 * 60_000, 200);
            const rev = done?.items[0]?.documentRevisionId;
            if (!rev) return null;
            revs.push({ doc: b.doc, revision: rev });
          }
          return revs;
        });
        record(`импорт оригиналов профиля md: ${plan.length} PDF, ${pagesTotal} страниц`, originals.ms);
        const rdweb = await timed(async () => {
          const runs: string[] = [];
          for (const { doc, revision } of originals.value ?? []) {
            const r = await expectStatus(
              await api.call(`/document-revisions/${revision}/recognition-imports?name=${encodeURIComponent(`${doc.name}.zip`)}`, { method: 'POST', raw: readFileSync(join(corpusDir, `${doc.index}.zip`)), headers: key() }),
              [202],
              'импорт распознавания RDWeb',
            );
            runs.push(((await r.json()) as { id: string }).id);
          }
          return waitFor(async () => {
            const q = await admin<{ done: number; failed: number }>(
              "SELECT count(*) FILTER (WHERE status IN ('complete', 'partial', 'failed'))::int AS done, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM recognition_run WHERE id = ANY($1::uuid[])",
              [runs],
            );
            const row = q.rows[0]!;
            if (row.done < runs.length) return null;
            return row.failed === 0 ? runs : Promise.reject(new Error(`импорт распознавания RDWeb: отказов ${row.failed}`));
          }, 12 * 60 * 60_000, 2000);
        });
        record(`импорт распознавания RDWeb: ${plan.length} документов, ${pagesTotal} страниц, Markdown ${(mdBytes / 1024 ** 2).toFixed(0)} МБ`, rdweb.ms);
        revisions.push(...(originals.value ?? []).map((x) => x.revision));
      } finally {
        rmSync(corpusDir, { recursive: true, force: true });
      }
    }

    // ---- Состав этапа и снимок области — входы поиска и проверки (как в smoke этапа 05)
    const draft = await expectStatus(await api.call(`/stages/${stageId}/source-set-revisions`, { method: 'POST', body: {}, headers: key() }), [200, 201], 'черновик состава');
    const draftId = ((await draft.json()) as { id: string }).id;
    const items = await expectStatus(
      await api.call(`/source-set-revisions/${draftId}/items`, { method: 'PUT', headers: { 'If-Match': draft.headers.get('etag') ?? '' }, body: { items: revisions.map((id) => ({ documentRevisionId: id, inclusion: 'included' })) } }),
      [200],
      'состав этапа',
    );
    await expectStatus(await api.call(`/source-set-revisions/${draftId}/freeze`, { method: 'POST', headers: { 'If-Match': items.headers.get('etag') ?? '', ...key() }, body: {} }), [200], 'заморозка состава');
    await expectStatus(await api.call(`/stages/${stageId}/evidence-scopes`, { method: 'POST', body: {}, headers: key() }), [200, 201], 'снимок области');

    // ---- Индекс поиска и векторы: активная версия построена заявленной моделью и полна (R17-06). Пока модель не
    // проверена, worker строит текстовую версию; векторная заменит её позже — текстовая итогом индексации не считается.
    type IIndexState = { missing_units: number; missing_vectors: number; chunks: number; vectors: number; fragments: number; model: string | null; dim: number | null };
    let last: IIndexState | null = null;
    const idx = await timed(() =>
      waitFor(async () => {
        last = (
          await admin<IIndexState>(
            `SELECT (SELECT count(*)::int FROM recognition_run r WHERE r.status IN ('complete', 'partial') AND NOT EXISTS (SELECT 1 FROM search_index_unit u WHERE u.index_version_id = v.id AND u.source_unit_id = r.id)) AS missing_units,
                    (SELECT count(*)::int FROM search_chunk c WHERE c.index_version_id = v.id AND v.embedding_model IS NOT NULL AND NOT EXISTS (SELECT 1 FROM search_chunk_vector x WHERE x.chunk_id = c.id)) AS missing_vectors,
                    (SELECT count(*)::int FROM search_chunk c WHERE c.index_version_id = v.id) AS chunks,
                    (SELECT count(*)::int FROM search_chunk_vector) AS vectors, (SELECT count(*)::int FROM evidence_fragment) AS fragments,
                    v.embedding_model AS model, v.embedding_dim AS dim
               FROM search_index_version v WHERE v.status = 'active'`,
          )
        ).rows[0] ?? null;
        return last && last.missing_units === 0 && last.missing_vectors === 0 && indexModelProblem(setup, last) === null ? last : null;
      }, 6 * 60 * 60_000, 2000),
    );
    const state = last as IIndexState | null;
    record('индекс поиска и векторы активной версии полны', idx.ms, idx.ms === null ? (indexModelProblem(setup, state) ?? `активная версия неполна: единиц вне индекса ${state?.missing_units ?? '—'}, чанков без векторов ${state?.missing_vectors ?? '—'}`) : '');
    info(`индекс: фрагментов ${state?.fragments ?? 0}, чанков ${state?.chunks ?? 0}, векторов ${state?.vectors ?? 0}; модель эмбеддингов активной версии «${state?.model ?? '—'}», размерность ${state?.dim ?? '—'}`);

    // ---- Поиск: p50 / p95 до итогового результата — только по полным запросам (R17-07)
    const queries = ['Стромынка', 'договор подряда', 'срок выполнения работ', 'гарантийный срок', 'стоимость работ', 'письмо заказчика', 'армирование монолитных конструкций', 'гидроизоляция кровли'];
    const outcomes: ISearchOutcome[] = [];
    for (let i = 0; i < P.queries; i += 1) {
      const t0 = Date.now();
      const q = queries[i % queries.length]!;
      const r = await expectStatus(await api.call('/search', { method: 'POST', body: { context: { kind: 'tender', tenderId: demo.id, mode: 'working', stageId }, query: q, limit: 10 }, headers: key() }), [200], 'поиск');
      let view = (await r.json()) as ISearchRunView & { searchRunId: string };
      while (view.status === 'pending' && Date.now() - t0 < 120_000) {
        await sleep(100);
        view = (await (await expectStatus(await api.call(`/search-runs/${view.searchRunId}`), [200], 'итог поиска')).json()) as ISearchRunView & { searchRunId: string };
      }
      outcomes.push(searchOutcome(q, Date.now() - t0, view));
    }
    // По веткам (timings прогона) и по запросам: частое слово синтетического корпуса совпадает почти с каждым чанком,
    // редкое — с единицами; без разбивки p50 смешивает оба случая.
    const search = summarizeSearch(outcomes, P.queries);
    for (const l of search.lines) info(l);
    record('поиск: все запросы полные (точная, полнотекстовая и смысловая ветки), текст документов находится', search.passed ? search.totalMs : null, search.note);

    // ---- Прогон проверки этапа
    const review = await timed(async () => {
      const run = (await (await expectStatus(await api.call(`/stages/${stageId}/review-runs`, { method: 'POST', body: {}, headers: key() }), [201], 'прогон проверки')).json()) as { id: string };
      return waitFor(async () => {
        const r = (await (await api.call(`/review-runs/${run.id}`)).json()) as { status: string };
        return ['completed', 'completed_with_gaps', 'failed'].includes(r.status) ? r : null;
      }, 60 * 60_000);
    });
    record('прогон проверки этапа', review.ms, review.value ? `итог ${review.value.status}` : '');

    // ---- Сборка комплекта (демо-формы, LibreOffice): шаги smoke этапов 11 и 12
    const notes: string[] = [];
    const rec = (_step: string, ok: boolean, note = '') => {
      if (!ok) notes.push(`${_step}${note ? ` (${note})` : ''}`);
    };
    const call = (client: ApiClient) => (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
      fetchLike(client, path, init);
    const smokeForms = await smokeStep('smoke-11.mjs', 'smokeForms');
    const smokeRelease = await smokeStep('smoke-12.mjs', 'smokeRelease');
    // Как в smoke: api — администратор-руководитель (утверждает шаблон, согласует), api2 — инженер тендера.
    await smokeForms({ root: ROOT, api: call(adminApi), api2: call(api), record: rec, idem: key, json: { 'Content-Type': 'application/json' }, stageId });
    const gen = await timed(async () => {
      const r = await smokeRelease({ root: ROOT, api: call(adminApi), api2: call(api), record: rec, waitFor, idem: key, json: { 'Content-Type': 'application/json' }, stageId });
      return r?.candidateId ? r : null;
    });
    record('сборка комплекта: DOCX и XLSX по формам, PDF-превью LibreOffice, манифест', notes.length === 0 ? gen.ms : null, notes.slice(0, 2).join('; '));

    // ---- Копия
    const t0 = Date.now();
    const backup = await new Promise<number | null>((done) => execFile(process.execPath, ['scripts/ops/backup.ts'], { cwd: ROOT, env, windowsHide: true }, (err) => done(err ? null : 0)));
    record('копия ops:backup (дамп и файлы)', backup === null ? null : Date.now() - t0);
    const size = await admin<{ db: string; files: string }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS db, (SELECT pg_size_pretty(coalesce(sum(size_bytes), 0)) FROM blob) AS files");
    info(`объём: база ${size.rows[0]!.db}, файлы хранилища ${size.rows[0]!.files}`);
  } catch (err) {
    if (!interrupted) record('замеры прерваны', null, err instanceof Error ? err.message : 'unknown');
  } finally {
    await cleanup();
  }
};

// Удаляется только база этого запуска: создана им и несёт его метку.
const dropOwnDb = async (): Promise<void> => {
  const mark = await admin<{ mark: string | null }>("SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = $1", [DB], 'postgres');
  if (mark.rowCount === 0) return;
  if (mark.rows[0]!.mark !== RUN_MARK) {
    info(`база ${DB} не удалена: метка запуска не совпала`);
    return;
  }
  await admin(`DROP DATABASE ${DB} WITH (FORCE)`, [], 'postgres');
};
let cleaning: Promise<void> | null = null;
const cleanup = (): Promise<void> =>
  (cleaning ??= (async () => {
    for (const p of procs) await stopNode(p, 30_000);
    await hubClose?.();
    if (ownDb) await dropOwnDb().catch((err: unknown) => info(`база ${DB} не удалена: ${err instanceof Error ? err.message : 'unknown'}`));
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  })());

// Шаги smoke ждут fetch-подобный api(path, init) с телом-строкой.
const fetchLike = async (client: ApiClient, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
  const headers = { ...(init.headers ?? {}) };
  const ct = headers['Content-Type'];
  delete headers['Content-Type'];
  if (ct === 'application/octet-stream') return client.call(path, { method: init.method ?? 'GET', headers, raw: Buffer.from(init.body as Uint8Array) });
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
  return client.call(path, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
};

const finish = (): void => {
  const summary = `Итог: ${notRun ? 'NOT_RUN' : failed ? 'FAIL' : 'PASS'}`;
  lines.push(summary);
  console.log(summary);
  const out = resolve(argValue('out') ?? join(ROOT, 'artifacts', 'stage-17', `measure-${PROFILE}.log`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  process.exitCode = notRun ? 3 : failed ? 1 : 0;
};

// Ctrl+C и остановка: процессы, своя база и временные каталоги (в том числе корпус) убираются, журнал пишется.
// Windows доставляет Ctrl+C консоли как SIGINT. Процессные тесты на Windows шлют IPC { type: 'shutdown' }: child.kill()
// там всегда завершает процесс принудительно (как у server и worker, packages/config/src/lifecycle.ts).
// process.exit — после записи журнала: основной сценарий может ждать часами.
const stop = (reason: string): void => {
  if (interrupted) return;
  interrupted = true;
  record('замеры прерваны', null, reason);
  void cleanup()
    .catch(() => undefined)
    .finally(() => {
      finish();
      process.exit(1);
    });
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop(`сигнал ${sig}`));
process.on('message', (msg: unknown) => {
  if ((msg as { type?: unknown } | null)?.type === 'shutdown') stop('команда остановки по IPC');
});
// Канал IPC (если замер запущен с ним) не держит процесс после итога.
process.channel?.unref();

main().finally(() => {
  if (!interrupted) finish();
});
