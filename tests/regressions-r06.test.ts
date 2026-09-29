// R06-01 (Review 06-pre-2): повтор id строки boq-items-full при прежних счётчиках (A, B, C → A, A, C).
// Первая линия — PortalCaptureStrategy: причина item_duplicated, попытка inconsistent, содержимого и
// ревизии нет, до уникальности БД дело не доходит. Вторая линия — worker: нарушение уникальности состава
// содержимого расчёта (23505) — отказ content_rejected_by_db без повторов, а не internal.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPortalCaptureResult } from '../packages/adapters/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';

// Вторую линию штатно не достать: стратегия ловит повтор раньше. Подмена результата runPortalCapture
// имитирует пробел стратегии; без подмены функция работает как есть.
const hooks = vi.hoisted(() => ({ tamper: null as ((r: IPortalCaptureResult) => IPortalCaptureResult) | null, calls: 0 }));
vi.mock('@kontur/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/adapters/src/index.ts')>();
  return {
    ...actual,
    runPortalCapture: async (...args: Parameters<typeof actual.runPortalCapture>): Promise<IPortalCaptureResult> => {
      hooks.calls += 1;
      const r = await actual.runPortalCapture(...args);
      return hooks.tamper ? hooks.tamper(r) : r;
    },
  };
});

const { runPortalCapture, TenderHubApiSource, TenderHubHttpClient } = await import('../packages/adapters/src/index.ts');
const { isContentRejectedByDb } = await import('../apps/worker/src/handlers/calculation.ts');

let db: ITestDb;
let s: IScenario;
let hub: IFakeTenderHub;
let worker: WorkerRuntime;
let boss: TestClient;

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  const config = tenderHubConfig(testConfig(), hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  boss = await adminMember(db, s, app, s.tenderA);
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});
beforeEach(() => {
  hub.tenders.clear();
  hub.tenders.set(TH.tender, standardTender());
  hub.beforeResponse = null;
  hub.requests.length = 0;
  hooks.tamper = null;
  hooks.calls = 0;
});

// A, B, C → A, A, C: вторая строка позиции 1.1 получает id первой. Общее число строк (3), items_count
// позиции (2), набор позиций и признаки шапки остаются прежними.
const duplicateLine = (): void => {
  hub.tenders.get(TH.tender)!.items.find((i) => i.id === TH.l2)!.id = TH.l1;
};

const freshStage = async (): Promise<string> => {
  const st = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: `Этап ${Math.random().toString(36).slice(2, 7)}` }, { headers: idem() });
  expect(st.status, st.text).toBe(201);
  await linkSource(boss, st.body.id, TH.tender);
  return st.body.id as string;
};
const count = async (sql: string, params: unknown[] = []): Promise<number> => (await db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;
const revisionCount = (stageId: string): Promise<number> => count('SELECT count(*)::int AS n FROM calculation_revision WHERE stage_id = $1', [stageId]);
const contentCount = (): Promise<number> => count('SELECT count(*)::int AS n FROM calculation_content');

describe('R06-01: повтор id строки boq-items-full', () => {
  it('стратегия находит повтор до БД: inconsistent только с item_duplicated; число строк, items_count, позиции и шапка прежние', async () => {
    duplicateLine();
    const http = new TenderHubHttpClient({ baseUrl: hub.url, apiKey: TH_KEY, timeoutMs: 5000, rateLimitPerMinute: 1000, maxResponseBytes: 8 << 20, rateLimitWaits: 0 });
    const r = await runPortalCapture(new TenderHubApiSource(http), TH.tender);
    expect(r.consistency.outcome).toBe('inconsistent');
    // Другие причины молчат: повтор скрыт от счётчиков, его видит только проверка уникальности.
    expect(r.consistency.reasons.map((x) => x.code)).toEqual(['item_duplicated']);
    expect(r.content).toBeNull();
    expect(r.consistency.counts).toMatchObject({ positionsPaged: 4, positionsWithCosts: 4, boqItems: 3 });
    expect(r.consistency.before).toEqual(r.consistency.after);
    expect(r.consistency.before).toMatchObject({ positionCount: 4, boqItemCount: 3 });
  });

  it('через worker: все попытки inconsistent с item_duplicated, выгрузка inconsistent; содержимого и ревизии нет', async () => {
    duplicateLine();
    const stage = await freshStage();
    const contents = await contentCount();
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'inconsistent', failure: { code: 'source_changed' }, revisionId: null, contentId: null });
    expect(cap.attempts.length).toBeGreaterThan(0);
    for (const a of cap.attempts) {
      expect(a.outcome).toBe('inconsistent');
      expect(a.reasons.map((x: { code: string }) => x.code)).toEqual(['item_duplicated']);
    }
    expect(await revisionCount(stage)).toBe(0);
    expect(await contentCount()).toBe(contents);
  });

  it('вторая линия: повтор дошёл до БД — 23505 по calculation_line_key даёт content_rejected_by_db, одна попытка без повторного чтения TenderHub', async () => {
    const stage = await freshStage();
    const contents = await contentCount();
    hooks.tamper = (r) => {
      const lines = r.content!.lines;
      return { ...r, content: { ...r.content!, lines: [lines[0]!, { ...lines[1]!, externalItemId: lines[0]!.externalItemId }, ...lines.slice(2)] } };
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'content_rejected_by_db' }, revisionId: null });
    expect(cap.failure.detail).toContain('calculation_line_key');
    // Детерминированный отказ не повторяется: одна попытка задания и одно чтение TenderHub (шапка до и после).
    expect(cap.attempts).toHaveLength(1);
    expect(cap.attempts[0]).toMatchObject({ outcome: 'failed', code: 'content_rejected_by_db' });
    expect(hooks.calls).toBe(1);
    const job = (await db.pool.query<{ status: string; attempts: number; last_error_code: string }>('SELECT status, attempts, last_error_code FROM job WHERE id = (SELECT job_id FROM calculation_capture WHERE id = $1)', [cap.id])).rows[0];
    expect(job).toEqual({ status: 'failed', attempts: 1, last_error_code: 'content_rejected_by_db' });
    expect(hub.requests.filter((q) => q.path.endsWith('/overview'))).toHaveLength(2);
    expect(await revisionCount(stage)).toBe(0);
    expect(await contentCount()).toBe(contents);
  });

  it('вторая линия узкая: 23505 — отказ содержимого только по ограничениям состава содержимого расчёта', () => {
    expect(isContentRejectedByDb({ code: '23505', constraint: 'calculation_line_key' })).toBe(true);
    expect(isContentRejectedByDb({ code: '23505', constraint: 'calculation_position_key' })).toBe(true);
    expect(isContentRejectedByDb({ code: '23505', constraint: 'calculation_revision_seq_key' })).toBe(false);
    expect(isContentRejectedByDb({ code: '23505', constraint: 'job_dedupe_active_key' })).toBe(false);
    expect(isContentRejectedByDb({ code: '23505' })).toBe(false);
    expect(isContentRejectedByDb({ code: '23514' })).toBe(true);
    expect(isContentRejectedByDb({ code: '55000' })).toBe(true);
    expect(isContentRejectedByDb(new Error('сеть'))).toBe(false);
  });

  it('обычный BOQ с уникальными id — согласованная выгрузка и ревизия, как прежде', async () => {
    const stage = await freshStage();
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'complete', failure: null });
    expect(cap.consistency).toMatchObject({ outcome: 'consistent', reasons: [] });
    expect(hooks.calls).toBe(1);
    expect(await revisionCount(stage)).toBe(1);
  });
});
