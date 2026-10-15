// Регрессии Review 17-4 (docs/reviews/17-review-4.md): достоверность журнала замера scripts/ops/measure.ts.
//   R17-06 — --real-model при встроенных fake / none не подписывает замер живым: отказ до замеров, код 3, без PASS;
//            контроль — настроенный HTTP-провайдер: PASS, в журнале модель и размерность активной версии индекса;
//   R17-07 — отказ смысловой ветки после успешной индексации — неполный запрос: шаг поиска FAIL, причина и счётчик
//            в журнале, время неполных отдельно от p50/p95 полных, код 1.
// Интеграционные случаи запускают настоящий measure.ts (server, worker, временная база kontur_kp_test_measure_…).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { indexModelProblem, modelSetup, searchIncompleteReason, searchOutcome, summarizeSearch, type ISearchRunView } from '../scripts/ops/measure-lib.ts';
import { ADMIN_URL } from './helpers.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

const ROOT = resolve(import.meta.dirname, '..');
const BASE_ENV = { KONTUR_ENV: 'test', DATABASE_URL: 'postgresql://kontur_app@127.0.0.1:1/x', STORAGE_ROOT: '/tmp/x', ALLOWED_ORIGINS: 'http://127.0.0.1:1' };
const LIVE_ENV = {
  MODEL_PROVIDER: 'openai_compatible',
  MODEL_BASE_URL: 'http://127.0.0.1:1234/v1',
  MODEL_NAME: 'qwen-chat',
  MODEL_API_KEY: 'chat-key-must-not-leak',
  EMBEDDING_PROVIDER: 'openai_compatible',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1',
  EMBEDDING_MODEL: 'emb-model',
  EMBEDDING_API_KEY: 'emb-key-must-not-leak',
  EMBEDDING_DIM: '8',
};

const view = (over: Partial<ISearchRunView> = {}): ISearchRunView => ({
  status: 'complete',
  semantic: { status: 'complete', reason: null },
  scope: { chunksWithoutVectors: 0, unitsNotIndexed: 0 },
  failureCode: null,
  timings: { exactMs: 1, ftsMs: 2, vectorMs: 3 },
  fused: { items: [1, 2] },
  ...over,
});

describe('оценка замера (measure-lib)', () => {
  it('R17-06: живая подпись — только при openai_compatible у обоих провайдеров; ключи в журнал не попадают', () => {
    const fake = modelSetup({ ...BASE_ENV, MODEL_PROVIDER: 'fake', EMBEDDING_PROVIDER: 'fake', EMBEDDING_DIM: '16' }, true);
    expect(fake.refusal).toHaveLength(2);
    expect(fake.refusal.join(' ')).toContain('EMBEDDING_PROVIDER=fake');
    expect(fake.identity).not.toMatch(/^живая/u);
    const none = modelSetup({ ...BASE_ENV, ...LIVE_ENV, MODEL_PROVIDER: '' }, true);
    expect(none.refusal).toEqual([expect.stringContaining('MODEL_PROVIDER=none')]);
    const live = modelSetup({ ...BASE_ENV, ...LIVE_ENV }, true);
    expect(live.refusal).toEqual([]);
    expect(live.identity).toMatch(/^живая: генеративная «qwen-chat».*эмбеддинги «emb-model».*размерность 8/u);
    expect(live.identity).toContain('сервер 127.0.0.1:1234');
    expect(live.identity).not.toMatch(/must-not-leak/u);
    expect([live.embeddingModel, live.embeddingDim]).toEqual(['emb-model', 8]);
    // Неверная конфигурация — отказ с причиной, а не замер.
    const bad = modelSetup({ ...BASE_ENV, ...LIVE_ENV, EMBEDDING_BASE_URL: 'https://api.example.com/v1' }, true);
    expect(bad.refusal.join(' ')).toContain('EMBEDDING_BASE_URL');
    const synthetic = modelSetup({ ...BASE_ENV, MODEL_PROVIDER: 'fake', EMBEDDING_PROVIDER: 'fake', EMBEDDING_DIM: '16' }, false);
    expect(synthetic.identity).toMatch(/^поддельная.*синтетический замер/u);
    expect(synthetic.embeddingModel).toBe('fake-hash-16');
  });

  it('R17-06: активная версия индекса должна быть построена заявленной моделью', () => {
    const live = modelSetup({ ...BASE_ENV, ...LIVE_ENV }, true);
    expect(indexModelProblem(live, { model: 'emb-model', dim: 8 })).toBeNull();
    expect(indexModelProblem(live, { model: 'fake-hash-16', dim: 16 })).toContain('«fake-hash-16»');
    expect(indexModelProblem(live, { model: 'emb-model', dim: 16 })).toContain('размерность');
    expect(indexModelProblem(live, { model: null, dim: null })).toContain('без векторов');
    expect(indexModelProblem(live, null)).toContain('нет');
  });

  it('R17-07: отказ, деградация, истёкшее ожидание и неполная ветка — неполный запрос', () => {
    expect(searchIncompleteReason(view())).toBeNull();
    expect(searchIncompleteReason(view({ semantic: { status: 'complete', reason: 'query_vector_cached' } }))).toBeNull();
    expect(searchIncompleteReason(null)).toBe('ожидание итога истекло');
    expect(searchIncompleteReason(view({ status: 'pending', semantic: { status: 'running', reason: null } }))).toBe('ожидание итога истекло');
    expect(searchIncompleteReason(view({ status: 'degraded', semantic: { status: 'failed', reason: 'semantic_failed' }, timings: { exactMs: 1, ftsMs: 2 } }))).toBe(
      'итог degraded, смысловая ветка failed (semantic_failed)',
    );
    expect(searchIncompleteReason(view({ status: 'degraded', semantic: { status: 'timeout', reason: 'deadline' } }))).toContain('timeout');
    expect(searchIncompleteReason(view({ status: 'failed', failureCode: 'scope_violation', semantic: { status: 'failed', reason: null } }))).toContain('scope_violation');
    expect(searchIncompleteReason(view({ timings: { exactMs: 1, ftsMs: 2 } }))).toBe('нет времени ветки: векторная');
    expect(searchIncompleteReason(view({ scope: { chunksWithoutVectors: 4, unitsNotIndexed: 0 } }))).toBe('чанков без векторов: 4');
    expect(searchIncompleteReason(view({ scope: { chunksWithoutVectors: 0, unitsNotIndexed: 2 } }))).toBe('единиц вне индекса: 2');
  });

  it('R17-07: p50/p95 — только полные запросы; неполные — счётчик, причины и своё время; шаг не проходит', () => {
    const failedView = view({ status: 'degraded', semantic: { status: 'failed', reason: 'semantic_failed' }, timings: { exactMs: 1, ftsMs: 2 } });
    const outcomes = [
      searchOutcome('Стромынка', 5000, failedView),
      searchOutcome('договор подряда', 100, view()),
      searchOutcome('Стромынка', 7000, failedView),
      searchOutcome('договор подряда', 300, view()),
    ];
    const s = summarizeSearch(outcomes, 4);
    expect(s.passed).toBe(false);
    expect(s.note).toBe('неполных запросов 2 из 4: «итог degraded, смысловая ветка failed (semantic_failed)» × 2');
    expect(s.totalMs).toBe(400);
    expect(s.lines[0]).toBe('поиск, полные запросы: 2 из 4; до итога p50 300 мс, p95 300 мс, максимум 300 мс (найдено в первом — 2)');
    expect(s.lines[1]).toMatch(/^поиск, неполные запросы: 2 из 4 — .*semantic_failed.*; до итога p50 7000 мс, максимум 7000 мс — в p50\/p95 полных не входит$/u);
    expect(s.lines.at(-1)).toContain('«Стромынка» — (неполных 2 из 2)');
    const ok = summarizeSearch([searchOutcome('a', 10, view()), searchOutcome('b', 20, view())], 2);
    expect([ok.passed, ok.note, ok.totalMs]).toEqual([true, '', 30]);
    expect(summarizeSearch([searchOutcome('a', 10, view())], 2).note).toBe('выполнено запросов 1 из 2');
    expect(summarizeSearch([searchOutcome('a', 10, view({ fused: { items: [] } }))], 1).note).toBe('первый запрос ничего не нашёл');
  });
});

// Управляемый OpenAI-совместимый сервер модели: детерминированные векторы размерности 8; эмбеддинг ровно одного
// текста failQuery — HTTP 422 (отказ смысловой ветки запроса при успешной индексации).
let server: Server;
let modelUrl = '';
let failQuery: string | null = null;
const embedInputs: string[][] = [];
const vec = (text: string): number[] => [...createHash('sha256').update(text).digest().subarray(0, 8)].map((b) => b / 255 - 0.5);

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { input?: unknown }) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/embeddings')) {
        const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input)];
        embedInputs.push(input);
        if (failQuery !== null && input.length === 1 && input[0] === failQuery) {
          res.writeHead(422);
          res.end(JSON.stringify({ error: { message: 'управляемый отказ фикстуры' } }));
          return;
        }
        res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vec(t) })) }));
      } else if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'chat-fixture' }, { id: 'emb-fixture' }] }));
      } else res.end(JSON.stringify({ choices: [{ message: { content: '{"answer": "ok"}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  modelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
});

const HTTP_MODEL = (): Record<string, string> => ({
  MODEL_PROVIDER: 'openai_compatible',
  MODEL_BASE_URL: modelUrl,
  MODEL_NAME: 'chat-fixture',
  MODEL_API_KEY: '',
  EMBEDDING_PROVIDER: 'openai_compatible',
  EMBEDDING_BASE_URL: modelUrl,
  EMBEDDING_MODEL: 'emb-fixture',
  EMBEDDING_API_KEY: '',
  EMBEDDING_DIM: '8',
});

const dbExists = async (name: string): Promise<boolean> => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
  } finally {
    await c.end();
  }
};

// Настоящий measure.ts отдельным процессом (асинхронно: сервер модели — в этом процессе). Временные каталоги замера —
// в своём TMP, база — kontur_kp_test_measure_… (её убирает и сам замер, и globalSetup тестов).
interface IRunOptions {
  queries?: number;
  docs?: number;
  // Имя базы замера; по умолчанию — новое.
  db?: string;
  // Действие во время замера (например, сигнал), параллельно ожиданию его завершения.
  during?: (child: ChildProcess, db: string) => Promise<void>;
}
const runMeasure = async (env: Record<string, string>, args: string[] = [], o: IRunOptions = {}): Promise<{ code: number | null; log: string; db: string; leftovers: string[] }> => {
  const tmp = mkdtempSync(join(tmpdir(), 'kontur-measure-it-'));
  const db = o.db ?? `kontur_kp_test_measure_${randomBytes(4).toString('hex')}`;
  const out = join(tmp, 'measure.log');
  try {
    const child = spawn(
      process.execPath,
      ['scripts/ops/measure.ts', '--positions', '3', '--lines', '2', '--docs', String(o.docs ?? 1), '--scans', '0', '--queries', String(o.queries ?? 2), '--profile', 'it', '--db', db, '--out', out, ...args],
      // Предохранитель: зависший замер не переживает тест.
      { cwd: ROOT, env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, KONTUR_TEST_ADMIN_URL: ADMIN_URL, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(240_000) },
    );
    // Вывод процесса — на случай, если журнал не записан (замер прерван предохранителем).
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const exited = new Promise<number | null>((done) => {
      child.on('error', () => undefined);
      child.on('close', (c) => done(c));
    });
    if (o.during) await o.during(child, db);
    const code = await exited;
    // Временные каталоги замера (хранилище, копия, корпус) он убирает сам.
    const leftovers = readdirSync(tmp).filter((n) => n.startsWith('kontur-measure'));
    return { code, log: existsSync(out) ? readFileSync(out, 'utf8') : `журнал не записан; вывод:\n${stdout}`, db, leftovers };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

describe('журнал measure.ts', () => {
  it('R17-06: --real-model при fake/fake — отказ до замеров: код 3, «Итог: NOT_RUN», без живой подписи и без PASS', async () => {
    const r = await runMeasure({ MODEL_PROVIDER: 'fake', EMBEDDING_PROVIDER: 'fake', EMBEDDING_DIM: '16' }, ['--real-model']);
    expect(r.code).toBe(3);
    expect(r.log).toContain('НЕ ВЫПОЛНЕНО: MODEL_PROVIDER=fake');
    expect(r.log).toContain('НЕ ВЫПОЛНЕНО: EMBEDDING_PROVIDER=fake');
    expect(r.log).toMatch(/^Итог: NOT_RUN$/mu);
    expect(r.log).not.toMatch(/Итог: PASS|Модель: живая|настроенная \(живая\)/u);
    expect(r.log).not.toMatch(/индекс поиска|поиск:/u);
    expect(await dbExists(r.db)).toBe(false);
  });

  it('контроль: настроенный HTTP-провайдер — PASS, модель и размерность активной версии в журнале, векторы — через HTTP', async () => {
    failQuery = null;
    const before = embedInputs.length;
    const r = await runMeasure(HTTP_MODEL(), ['--real-model']);
    expect(r.log).toMatch(/^# Модель: живая: генеративная «chat-fixture».*эмбеддинги «emb-fixture» \(ревизия unspecified, размерность 8/mu);
    expect(r.log).toContain('модель эмбеддингов активной версии «emb-fixture», размерность 8');
    expect(r.log).toContain('поиск, полные запросы: 2 из 2');
    expect(r.log).not.toContain('неполные запросы');
    expect(r.log).toMatch(/^Итог: PASS$/mu);
    expect(r.code).toBe(0);
    expect(r.leftovers).toEqual([]);
    const calls = embedInputs.slice(before);
    expect(calls.some((x) => x.length === 1 && x[0] === 'Стромынка'), 'эмбеддинг запроса — HTTP').toBe(true);
    expect(calls.some((x) => x.some((t) => t !== 'Стромынка' && t !== 'договор подряда')), 'векторы индекса — HTTP').toBe(true);
    expect(await dbExists(r.db)).toBe(false);
  });

  it('R17-07 (сценарий ревью): эмбеддинг единственного запроса отказывает после успешной индексации — FAIL с причиной, код 1', async () => {
    failQuery = 'Стромынка';
    try {
      const r = await runMeasure(HTTP_MODEL(), ['--real-model'], { queries: 1 });
      // Индексация успешна: шаг индекса с временем, не FAIL.
      expect(r.log).toMatch(/^\s+\d+\.\d с {2}индекс поиска и векторы активной версии полны$/mu);
      expect(r.log).toContain('модель эмбеддингов активной версии «emb-fixture», размерность 8');
      expect(r.log).toContain('поиск, полных запросов нет: 0 из 1');
      expect(r.log).toMatch(/поиск, неполные запросы: 1 из 1 — «итог degraded, смысловая ветка failed \(semantic_failed\)» × 1; до итога p50 \d+ мс, максимум \d+ мс — в p50\/p95 полных не входит/u);
      expect(r.log).toMatch(/^FAIL +поиск: все запросы полные .* — неполных запросов 1 из 1: .*semantic_failed/mu);
      expect(r.log).not.toContain('текст документов находится\n');
      expect(r.log).toMatch(/^Итог: FAIL$/mu);
      expect(r.log).not.toContain('Итог: PASS');
      expect(r.code).toBe(1);
    } finally {
      failQuery = null;
    }
  });

  it('R17-07: полный и неполный запрос — p50/p95 только по полному, неполный отдельно со своей причиной; код 1', async () => {
    failQuery = 'договор подряда';
    try {
      const r = await runMeasure(HTTP_MODEL(), ['--real-model'], { queries: 2 });
      expect(r.log).toMatch(/поиск, полные запросы: 1 из 2; до итога p50 (\d+) мс, p95 \1 мс, максимум \1 мс \(найдено в первом — [1-9]\d*\)/u);
      expect(r.log).toMatch(/поиск, неполные запросы: 1 из 2 — «итог degraded, смысловая ветка failed \(semantic_failed\)» × 1;/u);
      expect(r.log).toMatch(/по запросам, p50 до итога \(полные\): «Стромынка» \d+ мс; «договор подряда» — \(неполных 1 из 1\)/u);
      expect(r.log).toMatch(/^Итог: FAIL$/mu);
      expect(r.code).toBe(1);
    } finally {
      failQuery = null;
    }
  });
});

// R17-09 (Review 17-5): замер удаляет только базу, которую создал и пометил сам. Существующая база с маркером —
// в тестовом кластере, имя kontur_kp_test_… (её убирает и globalSetup тестов).
const adminOn = async <T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const markerDb = async (): Promise<string> => {
  const name = `kontur_kp_test_measure_guard_${randomBytes(4).toString('hex')}`;
  await adminOn('postgres', (c) => c.query(`CREATE DATABASE ${name}`));
  await adminOn(name, async (c) => {
    await c.query('CREATE TABLE review_marker (id int PRIMARY KEY)');
    await c.query('INSERT INTO review_marker VALUES (1)');
  });
  return name;
};
const markerRows = (name: string): Promise<number> => adminOn(name, async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM review_marker')).rows[0]!.n);
const dropDb = (name: string): Promise<unknown> => adminOn('postgres', (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));

describe('R17-09: база замера — только своя', () => {
  it('отказ по настройке модели — до действий с базой: существующая база и маркер целы', async () => {
    const name = await markerDb();
    try {
      const r = await runMeasure({ MODEL_PROVIDER: 'fake', EMBEDDING_PROVIDER: 'fake', EMBEDDING_DIM: '16' }, ['--real-model'], { db: name });
      expect(r.code).toBe(3);
      expect(r.log).toMatch(/^Итог: NOT_RUN$/mu);
      expect(await dbExists(name)).toBe(true);
      expect(await markerRows(name)).toBe(1);
    } finally {
      await dropDb(name);
    }
  });

  it('годная настройка, но база уже существует — замер не выполняется, база и маркер целы', async () => {
    const name = await markerDb();
    try {
      const r = await runMeasure({}, [], { db: name });
      expect(r.code).toBe(3);
      expect(r.log).toContain(`НЕ ВЫПОЛНЕНО: база ${name} уже существует`);
      expect(r.log).toMatch(/^Итог: NOT_RUN$/mu);
      expect(r.log).not.toMatch(/выгрузка расчёта/u);
      expect(await markerRows(name)).toBe(1);
    } finally {
      await dropDb(name);
    }
  });

  it('отказ шага после создания своей базы — замер прерван, своя база удалена', async () => {
    // Без документов состав этапа пуст, заморозку сервер отклоняет — шаг падает уже после подготовки своей базы.
    const r = await runMeasure({}, [], { docs: 0 });
    expect(r.log).toMatch(/^FAIL +замеры прерваны — заморозка состава: HTTP 409/mu);
    expect(r.code).toBe(1);
    expect(await dbExists(r.db)).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  // На Windows сигнал дочернему процессу из Node — принудительное завершение без обработчика: проверяется на POSIX.
  it.skipIf(process.platform === 'win32')('Ctrl+C (SIGINT) во время замера — своя база удалена, журнал записан, код 1', async () => {
    const r = await runMeasure({}, [], {
      during: async (child, db) => {
        // Сигнал — когда своя база уже создана и помечена.
        for (let i = 0; i < 600; i += 1) {
          const mark = await adminOn('postgres', (c) => c.query<{ mark: string | null }>("SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = $1", [db]));
          if (mark.rows[0]?.mark?.startsWith('kontur-measure:')) break;
          await new Promise((res) => setTimeout(res, 100));
        }
        child.kill('SIGINT');
      },
    });
    expect(r.log).toMatch(/^FAIL +замеры прерваны — сигнал SIGINT$/mu);
    expect(r.log).toMatch(/^Итог: FAIL$/mu);
    expect(r.code).toBe(1);
    expect(await dbExists(r.db)).toBe(false);
    expect(r.leftovers).toEqual([]);
  });
});
