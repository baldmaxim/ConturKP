// Регрессии по ревью 04-4 (docs/reviews/04-review-4.md): R04-14, R04-15, R04-18.
// Каждая проверка падает на коде передачи `c1604cd`.
//
// R04-14, R04-15 — результат прежнего ключа экрана не должен считаться текущим ни в одном
//   рендере. Раньше очистка жила в эффекте, то есть после render и commit: один кадр успевал
//   показать доказательство прежнего фрагмента (или выдачу прежней страницы) как текущее.
//   Здесь проверяется вынесенное чистое правило; поведение в браузере — сценарии ui-check.
// R04-18 — перекрывшим прогон считается только тот, кто занял следующее место в истории.
//   Отказавшая и отменённая попытка места не занимает (миграция 0008), поэтому и перекрытия
//   не создаёт: иначе один сбой объявлял бы прежнюю версию устаревшей.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { viewOf } from '../apps/web/src/hooks/keyedState.ts';
import { supersededBy } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

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

const newBlob = async (): Promise<string> => {
  const sha = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `r04e/${sha}`]);
  return sha;
};

const newRun = async (revisionId: string, supersedes: string | null): Promise<string> => {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id)
     VALUES ($1, $2, 'rdweb_export', $3, $4) RETURNING id`,
    [revisionId, s.tenderA, await newBlob(), supersedes],
  );
  return r.rows[0]!.id;
};

const start = (runId: string): Promise<unknown> =>
  db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [runId]);

const complete = async (runId: string): Promise<void> => {
  await start(runId);
  await db.pool.query("INSERT INTO recognition_page (run_id, page_index, width_px, height_px, status) VALUES ($1, 0, 100, 200, 'recognized')", [runId]);
  await db.pool.query(
    `UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1,
            finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [runId],
  );
};

// Отмена не ошибка: failure_code у cancelled пуст, у failed обязателен (миграции 0005, 0006).
const finishAs = async (runId: string, status: 'failed' | 'cancelled'): Promise<void> => {
  await start(runId);
  await db.pool.query(
    `UPDATE recognition_run SET status = $2, failure_code = $3, finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [runId, status, status === 'failed' ? 'test' : null],
  );
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => db.drop());

describe('R04-14, R04-15: результат принадлежит ключу экрана на этапе render', () => {
  const loaded = { key: 'A', data: { id: 'A' }, error: null, loading: false };

  it('при смене ключа прежний результат не отдаётся ни на одном рендере', () => {
    const view = viewOf(loaded, 'B');
    expect(view.data, 'данные прежнего фрагмента не могут быть данными нового').toBeNull();
    expect(view.loading, 'экран нового ключа — загрузка, а не готовый чужой результат').toBe(true);
    expect(view.key).toBe('B');
  });

  it('ошибка прежнего ключа не приписывается новому', () => {
    const failed = { key: 'A', data: null, error: new Error('нет доступа к A'), loading: false };
    expect(viewOf(failed, 'B').error).toBeNull();
  });

  it('тот же ключ отдаёт свой результат без мигания пустым экраном', () => {
    expect(viewOf(loaded, 'A')).toBe(loaded);
  });
});

describe('R04-18: перекрытие прогона считается только по занявшему место потомку', () => {
  it('отказавшая попытка не делает прогон перекрытым, а следующий успешный — делает', async () => {
    const revisionId = await registerPdf('История.pdf', fakePdf('история'));
    const a = await newRun(revisionId, null);
    await complete(a);

    // Попытка F не занимает место потомка (миграция 0008): A по-прежнему хвост истории.
    const f = await newRun(revisionId, a);
    await finishAs(f, 'failed');
    expect(await supersededBy(db.pool, a), 'отказ не перекрывает предыдущую версию').toBeNull();

    // Отменённая попытка — то же самое.
    const c = await newRun(revisionId, a);
    await finishAs(c, 'cancelled');
    expect(await supersededBy(db.pool, a), 'отмена не перекрывает предыдущую версию').toBeNull();

    // Успешная версия занимает место и перекрывает A.
    const b = await newRun(revisionId, a);
    await complete(b);
    expect(await supersededBy(db.pool, a)).toBe(b);
    expect(await supersededBy(db.pool, b)).toBeNull();
  });

  it('незавершённый потомок уже занимает место и виден как перекрывающий', async () => {
    const revisionId = await registerPdf('История-2.pdf', fakePdf('история 2'));
    const a = await newRun(revisionId, null);
    await complete(a);
    const b = await newRun(revisionId, a);
    expect(await supersededBy(db.pool, a), 'принятый к обработке архив уже занял место следующей версии').toBe(b);
  });

  it('API отдаёт то же определение потомка, что и история', async () => {
    const revisionId = await registerPdf('История-3.pdf', fakePdf('история 3'));
    const a = await newRun(revisionId, null);
    await complete(a);
    const f = await newRun(revisionId, a);
    await finishAs(f, 'failed');

    const view = await s.eng1.get(`/recognition-runs/${a}`);
    expect(view.status, view.text).toBe(200);
    expect(view.body.supersededByRunId).toBeNull();
  });
});
