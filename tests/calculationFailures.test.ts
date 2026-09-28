// Этап 06: отказы и повторы выгрузки TenderHub против поддельного сервера (ADR-007 §5, state-machines §6,
// README TenderHub «Ошибки и диагностика»). Ложной согласованной ревизии нет ни в одном отказе.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, runCaptures, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let hub: IFakeTenderHub;
let worker: WorkerRuntime;
let bossA: TestClient;
let bossB: TestClient;
let app: ReturnType<typeof makeApp>;
const base = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  const config = tenderHubConfig(base, hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  bossA = await adminMember(db, s, app, s.tenderA);
  bossB = await adminMember(db, s, app, s.tenderB);
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});
beforeEach(() => {
  hub.tenders.clear();
  hub.tenders.set(TH.tender, standardTender());
  hub.beforeResponse = null;
  hub.scope = 'tenders:read';
  hub.allowedTenders = null;
  hub.apiKey = TH_KEY;
});

// Свежий этап тендера A, связанный с эталонным тендером TenderHub (тот же тендер TenderHub можно
// связать с несколькими этапами — одна из схем Q-03).
const freshStage = async (externalTenderId = TH.tender): Promise<string> => {
  const st = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: `Этап ${Math.random().toString(36).slice(2, 7)}` }, { headers: idem() });
  expect(st.status, st.text).toBe(201);
  await linkSource(bossA, st.body.id, externalTenderId);
  return st.body.id as string;
};

const revisionCount = async (stageId: string): Promise<number> =>
  (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM calculation_revision WHERE stage_id = $1', [stageId])).rows[0]!.n;

describe('изменение данных во время выгрузки (inconsistent)', () => {
  it('источник меняется во всех попытках — выгрузка inconsistent, ревизии нет, каждая попытка в журнале', async () => {
    const stage = await freshStage();
    let tick = 0;
    hub.beforeResponse = (route) => {
      // Каждое чтение шапки видит новый updated_at в прошлом: признак «до и после» расходится.
      if (route === 'overview') {
        tick += 1;
        hub.tenders.get(TH.tender)!.updated_at = new Date(Date.parse('2026-09-01T00:00:00Z') + tick * 1000).toISOString();
      }
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'inconsistent', revisionId: null, contentId: null, failure: { code: 'source_changed' } });
    expect(cap.attempts).toHaveLength(3);
    for (const a of cap.attempts) expect(a).toMatchObject({ outcome: 'inconsistent', reasons: [expect.objectContaining({ code: 'markers_changed' })] });
    expect(await revisionCount(stage)).toBe(0);
  });

  it('позиция изменилась между постраничным чтением и with-costs — попытка inconsistent, повтор даёт согласованную ревизию', async () => {
    const stage = await freshStage();
    let changed = false;
    hub.beforeResponse = (route) => {
      if (route === 'positions_with_costs' && !changed) {
        changed = true;
        const p1 = hub.tenders.get(TH.tender)!.positions.find((p) => p.id === TH.p1)!;
        p1.work_name = 'Бетонирование плиты перекрытия (изм.)';
      }
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap.status).toBe('complete');
    expect(cap.attempts[0]).toMatchObject({ outcome: 'inconsistent', reasons: [expect.objectContaining({ code: 'position_changed_between_routes' })] });
    expect(cap.attempts[1]).toMatchObject({ outcome: 'consistent' });
    const pos = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}/positions`)).body.items.find((p: { externalPositionId: string }) => p.externalPositionId === TH.p1);
    expect(pos.workName).toBe('Бетонирование плиты перекрытия (изм.)');
  });

  it('строка с updated_at после начала выгрузки (по часам источника) — попытка inconsistent', async () => {
    const stage = await freshStage();
    let first = true;
    hub.beforeResponse = (route) => {
      const line = hub.tenders.get(TH.tender)!.items.find((i) => i.id === TH.l3)!;
      if (route === 'boq_items_full' && first) {
        first = false;
        line.updated_at = new Date(Date.now() + 60_000).toISOString();
      } else if (route === 'overview' && !first) {
        line.updated_at = '2026-09-01T10:00:00Z';
      }
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap.status).toBe('complete');
    expect(cap.attempts[0]).toMatchObject({ outcome: 'inconsistent', reasons: [expect.objectContaining({ code: 'row_updated_during_capture' })] });
  });

  it('число строк в шапке не сходится со строками маршрута — inconsistent, а не неполная ревизия', async () => {
    const stage = await freshStage();
    let once = true;
    hub.beforeResponse = (route) => {
      // После чтения строк пропала позиция 1.2: шапка «после» показывает 3 позиции вместо 4.
      if (route === 'overview' && !once) {
        const t = hub.tenders.get(TH.tender)!;
        t.positions = t.positions.filter((p) => p.id !== TH.p2);
      }
      if (route === 'boq_items_full') once = false;
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap.attempts[0]).toMatchObject({ outcome: 'inconsistent' });
    expect(cap.attempts[0].reasons.map((r: { code: string }) => r.code)).toContain('markers_changed');
    // Со второй попытки данные устойчивы (3 позиции) — ревизия из согласованного чтения.
    expect(cap.status).toBe('complete');
    const rev = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}`)).body;
    expect(rev.counts).toEqual({ positions: 3, lines: 3 });
  });
});

describe('ошибки сети и доступа', () => {
  it('обрыв на второй странице позиций — попытка failed (одна страница — не расчёт), повтор завершает выгрузку', async () => {
    const stage = await freshStage();
    hub.pageSize = 2;
    let pages = 0;
    hub.beforeResponse = (route) => {
      if (route === 'positions') {
        pages += 1;
        if (pages === 2) return { kind: 'drop' };
      }
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    hub.pageSize = 200;
    expect(cap.status).toBe('complete');
    expect(cap.attempts[0]).toMatchObject({ outcome: 'failed', adapterCode: 'UNAVAILABLE', retryable: true });
    expect(cap.attempts[1]).toMatchObject({ outcome: 'consistent' });
    expect(await revisionCount(stage)).toBe(1);
  });

  it('401 invalid API key — выгрузка failed сразу, без повторов; статус интеграции видит ошибку; ключ не печатается', async () => {
    const stage = await freshStage();
    hub.apiKey = 'thk_other_key';
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'auth_failed' } });
    expect(cap.attempts).toHaveLength(1);
    expect(JSON.stringify(cap)).not.toContain(TH_KEY);
    const src = (await s.eng1.get(`/stages/${stage}/calculation-source`)).body;
    expect(src.integration).toContainEqual(expect.objectContaining({ component: 'TenderHubReader', status: 'VERIFIED_FIXTURE', lastErrorCode: 'auth_failed' }));
  });

  it('401 invalid or expired token — отдельная причина: ключ не дошёл как X-API-Key', async () => {
    const stage = await freshStage();
    hub.beforeResponse = () => ({ kind: 'status', status: 401, detail: 'invalid or expired token' });
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'auth_header_rejected' } });
  });

  it('403: нет области tenders:read и тендер вне списка ключа — failed без повторов', async () => {
    const a = await freshStage();
    hub.scope = 'none';
    expect(await captureNow(db, worker, s.eng1, a)).toMatchObject({ status: 'failed', failure: { code: 'forbidden_scope' } });
    hub.scope = 'tenders:read';
    const b = await freshStage();
    hub.allowedTenders = ['00000000-0000-4000-8000-000000000000'];
    const cap = await captureNow(db, worker, s.eng1, b);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'forbidden_tender' } });
    expect(cap.attempts).toHaveLength(1);
  });

  it('404 — тендера нет или маршрута нет в сборке: failed', async () => {
    const stage = await freshStage('0d9b2c4e-0000-4000-8000-00000000abcd');
    expect(await captureNow(db, worker, s.eng1, stage)).toMatchObject({ status: 'failed', failure: { code: 'not_found' } });
  });

  it('429 без Retry-After — ожидание минутного окна и продолжение той же попытки', async () => {
    const stage = await freshStage();
    let limited = 0;
    hub.beforeResponse = (route) => {
      if (route === 'boq_items_full' && limited < 1) {
        limited += 1;
        return { kind: 'status', status: 429, detail: 'превышен лимит запросов для ключа' };
      }
    };
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap.status).toBe('complete');
    expect(cap.attempts).toHaveLength(1);
  });

  it('429 держится — попытки исчерпаны, failed rate_limited', async () => {
    const stage = await freshStage();
    hub.beforeResponse = (route) => (route === 'overview' ? { kind: 'status', status: 429 } : undefined);
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'rate_limited' } });
    expect(cap.attempts).toHaveLength(3);
  });

  it('503 ENDPOINT_DISABLED — не обходится: failed без повторов; прочие 5xx повторяются', async () => {
    const a = await freshStage();
    hub.beforeResponse = () => ({ kind: 'status', status: 503, code: 'ENDPOINT_DISABLED' });
    const disabled = await captureNow(db, worker, s.eng1, a);
    expect(disabled).toMatchObject({ status: 'failed', failure: { code: 'endpoint_disabled' } });
    expect(disabled.attempts).toHaveLength(1);
    const b = await freshStage();
    let failures = 0;
    hub.beforeResponse = (route) => {
      if (route === 'brief' && failures < 1) {
        failures += 1;
        return { kind: 'status', status: 502 };
      }
    };
    const recovered = await captureNow(db, worker, s.eng1, b);
    expect(recovered.status).toBe('complete');
    expect(recovered.attempts[0]).toMatchObject({ outcome: 'failed', code: 'unavailable', retryable: true });
  });

  it('ответ не JSON (прокси) — failed non_json_response', async () => {
    const stage = await freshStage();
    hub.beforeResponse = (route) => (route === 'overview' ? { kind: 'html' } : undefined);
    expect(await captureNow(db, worker, s.eng1, stage)).toMatchObject({ status: 'failed', failure: { code: 'non_json_response' } });
  });

  it('интеграция не настроена (U-04) — failed integration_not_configured, без обращения к TenderHub', async () => {
    const stage = await freshStage();
    const bare = makeWorker(db, base);
    const r = await s.eng1.post(`/stages/${stage}/calculation-captures`, {}, { headers: idem() });
    const before = hub.requests.length;
    await runCaptures(db, bare);
    const cap = (await s.eng1.get(`/calculation-captures/${r.body.id}`)).body;
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'integration_not_configured' } });
    expect(hub.requests.length).toBe(before);
  });
});

describe('идентичность тендера и сверка агрегатов', () => {
  it('номер тендера TenderHub принадлежит одному тендеру портала: другой тендер портала получает отказ', async () => {
    const a = await freshStage();
    expect((await captureNow(db, worker, s.eng1, a)).status).toBe('complete');
    await linkSource(bossB, s.stageB, TH.tender);
    const cap = await captureNow(db, worker, s.eng3, s.stageB);
    expect(cap).toMatchObject({ status: 'failed', failure: { code: 'external_identity_conflict' } });
    expect(await revisionCount(s.stageB)).toBe(0);
  });

  it('расхождение агрегатов источника показывается, ревизию не блокирует и не подгоняется', async () => {
    const stage = await freshStage();
    hub.tenders.get(TH.tender)!.positions.find((p) => p.id === TH.p1)!.base_total = n('1600');
    const cap = await captureNow(db, worker, s.eng1, stage);
    expect(cap.status).toBe('complete');
    const rev = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}`)).body;
    const base = rev.aggregates.checks.find((c: { check: string }) => c.check.startsWith('position.base_total'));
    expect(base).toMatchObject({ mismatch: 1, examples: [{ positionId: TH.p1, source: '1600', computed: '1500.75', diff: '99.25' }] });
  });
});

describe('выгрузка по сроку подачи из TenderHub (ADR-007 §7)', () => {
  it('наступил наблюдённый срок — одна выгрузка trigger=deadline; ревизия остаётся provisional; повторно не ставится', async () => {
    const stage = await freshStage();
    const deadline = new Date(Date.now() + 1500);
    const pg = `${deadline.toISOString().slice(0, 19).replace('T', ' ')}+00`;
    hub.tenders.get(TH.tender)!.submission_deadline = pg;
    const first = await captureNow(db, worker, s.eng1, stage);
    expect(first.sourceObserved.submissionDeadline).toBe(new Date(Math.floor(deadline.getTime() / 1000) * 1000).toISOString());
    expect(await worker.scheduleCalculationCaptures()).toBe(0);
    await new Promise((r) => setTimeout(r, 1800));
    expect(await worker.scheduleCalculationCaptures()).toBeGreaterThanOrEqual(1);
    await runCaptures(db, worker);
    const caps = (await s.eng1.get(`/stages/${stage}/calculation-captures`)).body.items;
    const auto = caps.find((c: { trigger: string }) => c.trigger === 'deadline');
    expect(auto).toMatchObject({ status: 'complete', requestedBy: null });
    const rev = (await s.eng1.get(`/calculation-revisions/${auto.revisionId}`)).body;
    expect(rev.kind).toBe('provisional');
    expect(await worker.scheduleCalculationCaptures()).toBe(0);
  });
});
