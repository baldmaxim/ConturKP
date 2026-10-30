// Этап 18 (D-044; проект §14, §15): правило итога КП (Q-05) и закрытый расчёт решением руководителя (Q-01).
// Правило итога: захват ставит `th_grand_total_vat_included` при итоге источника, без него — нет; блокер
// KP_TOTAL_UNRECONCILED (боевой, неснимаемый). Решение руководителя: права (БД и API), одна действующая запись на
// ревизию, неизменяемость, закрепление во входе кандидата, отзыв до и после выпуска, новая выгрузка не закрыта.
// Полный сценарий — на настоящем worker и LibreOffice (как approvalRelease).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runPortalCapture, TenderHubApiSource, TenderHubHttpClient } from '../packages/adapters/src/index.ts';
import {
  BLOCKERS,
  calculationContentHash,
  compareWithCalculation,
  dec,
  evaluateGate,
  isCalculationProvisional,
  KP_TOTAL_RULE_TH_GRAND_TOTAL,
  kpTotalHeaderFor,
  kpTotalSemanticsFor,
  openBlockerCodes,
  str,
  type IGateFacts,
} from '../packages/core/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import type { IFakeTender } from '../scripts/tenderhub-fake-data.ts';
import {
  acceptAll,
  acceptRisk,
  addVerifiedRevision,
  approve,
  assembled,
  buildStage13,
  closeStage13,
  codes,
  notApplicable,
  release,
  rerunReview,
  view,
  type ICandidate13,
  type IStage13,
} from './approvalFixtures.ts';
import { captureNow, standardTender, TH, TH_KEY } from './calculationFixtures.ts';
import { E, v2Tender } from './economicsFixtures.ts';
import { auditRows, idem } from './helpers.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// ---------------------------------------------------------------- Правило итога КП при захвате (Q-05)

describe('правило итога КП: захват ставит его только при итоге источника (D-044)', () => {
  let hub: IFakeTenderHub;
  beforeAll(async () => {
    hub = await startFakeTenderHub({ apiKey: TH_KEY });
  });
  afterAll(async () => hub.close());

  const capture = async (t: IFakeTender) => {
    hub.tenders.set(TH.tender, t);
    const http = new TenderHubHttpClient({ baseUrl: hub.url, apiKey: TH_KEY, timeoutMs: 2000, rateLimitPerMinute: 1000, maxResponseBytes: 8 << 20, rateLimitWaits: 0 });
    return (await runPortalCapture(new TenderHubApiSource(http), TH.tender)).content!;
  };

  it('итог источника есть — итог КП равен ему, RUB, правило th_grand_total_vat_included; описание — «в т.ч. НДС»', async () => {
    const c = await capture(standardTender());
    expect(c.header).toMatchObject({ sourceGrandTotal: '1860.9', kpTotal: '1860.9', kpTotalCurrency: 'RUB', kpTotalRule: KP_TOTAL_RULE_TH_GRAND_TOTAL });
    expect(kpTotalSemanticsFor(c.header)).toMatchObject({ status: 'rule_set', decision: 'D-044', vat: 'included', note: expect.stringMatching(/в т\.ч\. НДС/u) });
  });

  it('итога источника нет — правило не ставится (KP_TOTAL_NOT_APPROVED остаётся), описание — «правило не задано»', async () => {
    const t: Partial<IFakeTender> = standardTender();
    delete t.cached_grand_total;
    const c = await capture(t as IFakeTender);
    expect(c.header).toMatchObject({ sourceGrandTotal: null, kpTotal: null, kpTotalCurrency: null, kpTotalRule: null });
    expect(kpTotalSemanticsFor(c.header)).toMatchObject({ status: 'rule_not_set', question: 'Q-05' });
    expect(kpTotalHeaderFor(null)).toEqual({ kpTotal: null, kpTotalCurrency: null, kpTotalRule: null });
  });

  it('правило входит в хэш содержимого: прежние содержимые (без правила) неизменны и правила не получают', async () => {
    const withRule = await capture(standardTender());
    const without = { ...withRule, header: { ...withRule.header, kpTotal: null, kpTotalCurrency: null, kpTotalRule: null } };
    expect(calculationContentHash(withRule)).not.toBe(calculationContentHash(without));
  });
});

// ---------------------------------------------------------------- Ядро

const facts = (o: Partial<IGateFacts> = {}): IGateFacts => ({
  mode: 'production',
  actorAuthorized: true,
  actorSeesContent: true,
  approval: null,
  contentMismatch: [],
  reviewScopeMismatch: false,
  reviewOutdated: [],
  reviewMissing: false,
  reviewProcessing: [],
  uncoveredEvents: [],
  staleChannels: [],
  fieldsStale: [],
  calculationProvisional: false,
  templateDemo: false,
  kpTotalMissing: false,
  kpTotalUnreconciled: false,
  reviewUncertain: [],
  criticalFindings: [],
  questions: [],
  fieldsIncomplete: [],
  numbersUnverified: [],
  acceptances: [],
  ...o,
});

describe('ядро: единый предикат и блокер KP_TOTAL_UNRECONCILED', () => {
  it('CALCULATION_PROVISIONAL = provisional и нет действующего закреплённого решения; verified — никогда', () => {
    expect(isCalculationProvisional('provisional', false)).toBe(true);
    expect(isCalculationProvisional('provisional', true)).toBe(false);
    expect(isCalculationProvisional('verified', false)).toBe(false);
  });

  it('KP_TOTAL_UNRECONCILED — боевой, неснимаемый, класс целостности; в тестовом режиме не ставится', () => {
    expect(BLOCKERS.KP_TOTAL_UNRECONCILED).toEqual({ class: 'integrity', acceptable: false, productionOnly: true, subjectType: null });
    expect(openBlockerCodes(evaluateGate(facts({ kpTotalUnreconciled: true }), 'approve'))).toEqual(['KP_TOTAL_UNRECONCILED']);
    expect(openBlockerCodes(evaluateGate(facts({ kpTotalUnreconciled: true, mode: 'test' }), 'approve'))).toEqual([]);
    expect(openBlockerCodes(evaluateGate(facts({ kpTotalUnreconciled: true, kpTotalMissing: true }), 'release'))).toEqual(['KP_TOTAL_NOT_APPROVED', 'KP_TOTAL_UNRECONCILED']);
  });

  it('связь числа приложения с итогом КП: величина kp_total сверяется точно, без правила — «не сверено»', () => {
    const field = { unit: 'руб.', currency: 'RUB', scale: 2 };
    expect(compareWithCalculation(field, '1860.90', 'kp_total', '1860.9')).toEqual({ outcome: 'match', expected: '1860.9' });
    expect(compareWithCalculation(field, '1860', 'kp_total', '1860.9')).toMatchObject({ outcome: 'mismatch' });
    expect(compareWithCalculation(field, '1860.9', 'kp_total', null)).toMatchObject({ outcome: 'unverified' });
    expect(str(dec('1860.9'))).toBe('1860.9');
  });
});

// ---------------------------------------------------------------- Решение руководителя

let st: IStage13;
let rev = '';
let decision1 = '';
let decision2 = '';
let p0: ICandidate13;
let p1: ICandidate13;
let p2: ICandidate13;

const pgCode = async (sql: string, params: unknown[]): Promise<string> =>
  st.db.pool.query(sql, params).then(
    () => 'ok',
    (x: { code?: string }) => x.code ?? 'error',
  );
const scalar = async <T>(sql: string, params: unknown[]): Promise<T> => (await st.db.pool.query(sql, params)).rows[0]!.v as T;
const gateProblem = (id: string) => scalar<string | null>('SELECT candidate_gate_problem($1) AS v', [id]);
const closed = (id: string) => scalar<boolean>('SELECT calculation_closed_by_decision($1) AS v', [id]);

const INSERT_DECISION = `INSERT INTO calculation_closure_decision (tender_id, stage_id, calculation_revision_id, decided_by, reason) VALUES ($1, $2, $3, $4, 'Решение для проверки базы')`;
const INSERT_REVOCATION = `INSERT INTO calculation_closure_revocation (decision_id, revoked_by, reason) VALUES ($1, $2, 'Отзыв для проверки базы')`;
const insertDecision = (decidedBy: string, revisionId = rev, stage = st.e.s.stageA, tender = st.e.s.tenderA) => pgCode(INSERT_DECISION, [tender, stage, revisionId, decidedBy]);

const REASON = 'Расчёт согласован с руководителем, закрытие в TenderHub недоступно (X-01)';
const decide = (client = st.e.s.manager, revisionId = rev, reason = REASON) => client.post(`/calculation-revisions/${revisionId}/closure`, { reason }, { headers: idem() });
const revoke = (client = st.e.s.manager, revisionId = rev, reason = 'Расчёт изменён, закрытие отменяю') =>
  client.post(`/calculation-revisions/${revisionId}/closure/revoke`, { reason }, { headers: idem() });
const stateOf = async (revisionId = rev, client = st.e.s.manager) => {
  const r = await client.get(`/calculation-revisions/${revisionId}/closure`);
  expect(r.status, r.text).toBe(200);
  return r.body as { closed: boolean; canDecide: boolean; canRevoke: boolean; active: { id: string; decidedBy: { name: string }; reason: string } | null; history: { id: string; revocation: { revokedBy: { name: string } } | null }[] };
};
const closureInputs = async (candidateId: string): Promise<string[]> =>
  (await st.db.pool.query<{ ref_id: string }>("SELECT ref_id FROM candidate_input WHERE candidate_id = $1 AND kind = 'calculation_closure'", [candidateId])).rows.map((r) => r.ref_id);

// Боевой кандидат до согласования: решения по удержаниям, принятие бизнес-рисков, свежий вид.
const prepared = async (): Promise<ICandidate13> => {
  const c = await assembled(st, { mode: 'production' });
  await notApplicable(st, c.id);
  await acceptAll(st, await view(st, c.id));
  return view(st, c.id);
};

beforeAll(async () => {
  st = await buildStage13({ reconciledProvisional: true });
  rev = (await st.e.s.eng1.get(`/stages/${st.e.s.stageA}/calculation-revisions`)).body.items[0].id as string;
}, 900_000);
afterAll(async () => {
  await closeStage13(st);
});

describe('до решения: кандидат несёт CALCULATION_PROVISIONAL', () => {
  it('боевой комплект на сведённой provisional-ревизии: единственный блокер — CALCULATION_PROVISIONAL; БД согласна', async () => {
    p0 = await prepared();
    expect(codes(p0.gate.approve)).toEqual(['CALCULATION_PROVISIONAL']);
    expect(await gateProblem(p0.id)).toBe('CALCULATION_PROVISIONAL');
    expect(await closed(p0.id)).toBe(false);
    const s = await stateOf();
    expect(s).toMatchObject({ closed: false, canDecide: true, canRevoke: false, history: [] });
    // Инженер видит состояние, но кнопок не получает.
    expect(await stateOf(rev, st.e.s.eng1)).toMatchObject({ closed: false, canDecide: false, canRevoke: false });
  });
});

describe('права: решает и отзывает только руководитель тендера', () => {
  it('инженер: API — 403 с «запрещено» в журнале, БД — 42501; посторонний тендеру — 404; администратор без назначения — 42501', async () => {
    const r = await decide(st.e.s.eng1);
    expect(r.status, r.text).toBe(403);
    const denied = await auditRows(st.db.pool, "action = 'calculation.close' AND outcome = 'denied' AND actor_user_id = $1", [st.e.s.ids.eng1]);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.details).toMatchObject({ code: 'FORBIDDEN', capability: 'calculation.close' });
    expect(await insertDecision(st.e.s.ids.eng1)).toBe('42501');
    expect((await decide(st.e.s.eng3)).status).toBe(404);
    expect(await insertDecision(st.e.s.ids.admin)).toBe('42501');
    expect((await revoke(st.e.s.eng1)).status).toBe(403);
    expect(await scalar<number>('SELECT count(*)::int AS v FROM calculation_closure_decision', [])).toBe(0);
  });

  it('причина обязательна: короткая — 400; без права ничего не пишется', async () => {
    const r = await decide(st.e.s.manager, rev, 'ок');
    expect(r.status, r.text).toBe(400);
    expect(await pgCode(INSERT_DECISION.replace('Решение для проверки базы', '   '), [st.e.s.tenderA, st.e.s.stageA, rev, st.e.s.ids.manager])).toBe('23514');
  });

  it('роль приложения kontur_app имеет на обе таблицы только SELECT и INSERT; UPDATE, DELETE и TRUNCATE отвергает охранник и у владельца', async () => {
    const grants = await st.db.pool.query<{ t: string; p: string }>(
      "SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = 'kontur_app' AND table_name IN ('calculation_closure_decision', 'calculation_closure_revocation') ORDER BY 1, 2",
    );
    expect(grants.rows.map((g) => `${g.t}:${g.p}`)).toEqual([
      'calculation_closure_decision:INSERT',
      'calculation_closure_decision:SELECT',
      'calculation_closure_revocation:INSERT',
      'calculation_closure_revocation:SELECT',
    ]);
  });
});

describe('решение: одно действующее на ревизию', () => {
  it('руководитель решает — 201, состояние «закрыт», журнал calculation.close; повтор — 409; БД второе действующее отвергает', async () => {
    const r = await decide();
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ closed: true, canDecide: false, canRevoke: true, active: { decidedBy: { name: 'Руководитель' }, reason: REASON } });
    decision1 = r.body.active.id as string;
    const audit = await auditRows(st.db.pool, "action = 'calculation.close' AND outcome = 'allowed'");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ decisionId: decision1, reason: REASON });
    expect((await decide()).status).toBe(409);
    expect(await insertDecision(st.e.s.ids.manager)).toBe('23514');
    // Все участники видят отметку; решение, принятое после сборки, в прежнем комплекте не закреплено.
    expect(await stateOf(rev, st.e.s.eng1)).toMatchObject({ closed: true, active: { id: decision1 } });
    expect(await gateProblem(p0.id)).toBe('CALCULATION_PROVISIONAL');
    expect(await closed(p0.id)).toBe(false);
  });

  it('решение на чужую ревизию (другой этап и тендер) — 23514', async () => {
    expect(await insertDecision(st.e.s.ids.manager, rev, st.e.s.stageB, st.e.s.tenderB)).toBe('23514');
    expect(await insertDecision(st.e.s.ids.manager, '00000000-0000-4000-8000-000000000000')).toBe('23514');
  });
});

describe('вход кандидата: решение закрепляется и снимает CALCULATION_PROVISIONAL', () => {
  it('новый комплект закрепляет действующее решение входом calculation_closure; отпечаток входа иной; блокера нет; БД и сервер сходятся', async () => {
    p1 = await prepared();
    expect(await closureInputs(p1.id)).toEqual([decision1]);
    expect(await closureInputs(p0.id)).toEqual([]);
    expect(codes(p1.gate.approve)).toEqual([]);
    expect(await gateProblem(p1.id)).toBeNull();
    expect(await closed(p1.id)).toBe(true);
    const inputs = (p1 as unknown as { inputs: { calculationClosure: { decisionId: string; active: boolean; decidedBy: string } | null; inputsSha256: string } }).inputs;
    expect(inputs.calculationClosure).toMatchObject({ decisionId: decision1, active: true, decidedBy: 'Руководитель' });
    expect(inputs.inputsSha256).not.toBe((p0 as unknown as { inputs: { inputsSha256: string } }).inputs.inputsSha256);
    expect((p1 as unknown as { notes: string[] }).notes.join('\n')).toMatch(/CALCULATION_CLOSED_BY_DECISION/u);
    expect((p1 as unknown as { notes: string[] }).notes.join('\n')).not.toMatch(/CALCULATION_PROVISIONAL/u);
  });

  it('отзыв после закрепления, до согласования: инженер не отзывает; руководитель — 200; повторный отзыв — 409 и 23514; согласование отказывает', async () => {
    expect(await pgCode(INSERT_REVOCATION, [decision1, st.e.s.ids.eng1])).toBe('42501');
    const r = await revoke();
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ closed: false, canDecide: true, canRevoke: false, active: null });
    expect(r.body.history[0].revocation.revokedBy.name).toBe('Руководитель');
    expect((await revoke()).status).toBe(409);
    expect(await pgCode(INSERT_REVOCATION, [decision1, st.e.s.ids.manager])).toBe('23514');
    const audit = await auditRows(st.db.pool, "action = 'calculation.close_revoke' AND outcome = 'allowed'");
    expect(audit).toHaveLength(1);
    // Вход устарел: закреплённое решение больше не действует — блокер вернулся; согласование отказывает на сервере и в БД.
    p1 = await view(st, p1.id);
    expect(codes(p1.gate.approve)).toEqual(['CALCULATION_PROVISIONAL']);
    expect(await closed(p1.id)).toBe(false);
    expect(await gateProblem(p1.id)).toBe('CALCULATION_PROVISIONAL');
    const refused = await approve(st, p1);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['CALCULATION_PROVISIONAL']);
    expect(
      await pgCode("INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, '{}', $5)", [
        p1.id, st.e.s.tenderA, st.e.s.stageA, p1.contentHash, st.e.s.ids.manager,
      ]),
    ).toBe('23514');
  });
});

describe('отзыв до выпуска блокирует выпуск; выпущенное не меняется', () => {
  it('новое решение после отзыва; комплект согласован; отзыв — выпуск отказывает на сервере и в БД', async () => {
    const r = await decide();
    expect(r.status, r.text).toBe(201);
    decision2 = r.body.active.id as string;
    expect(decision2).not.toBe(decision1);
    expect((await stateOf()).history).toHaveLength(2);
    p2 = await prepared();
    expect(await closureInputs(p2.id)).toEqual([decision2]);
    expect(codes(p2.gate.approve)).toEqual([]);
    const a = await approve(st, p2);
    expect(a.status, a.text).toBe(200);
    // Незакоммиченный отзыв держит блокировку этапа: прямая вставка выпуска ждёт её, а не проверяет решение по старому снимку.
    const [h1, h2] = await Promise.all([st.db.pool.connect(), st.db.pool.connect()]);
    try {
      await h1.query('BEGIN');
      await h1.query(INSERT_REVOCATION, [decision2, st.e.s.ids.manager]);
      await h2.query('BEGIN');
      await h2.query("SET LOCAL lock_timeout = '300ms'");
      const waited = await h2
        .query(
          `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
           VALUES ($1, $2, $3, $4, 'production', 0, $5, $5, $5, '{}', $6)`,
          [p2.id, a.body.approval.id, st.e.s.tenderA, st.e.s.stageA, p2.contentHash, st.e.s.ids.eng1],
        )
        .then(() => 'inserted', (x: { code?: string }) => x.code ?? 'error');
      expect(waited).toBe('55P03');
    } finally {
      await h2.query('ROLLBACK').catch(() => undefined);
      await h1.query('ROLLBACK').catch(() => undefined);
      h1.release();
      h2.release();
    }
    // Два одновременных отзыва одного решения: действует один, второй видит чужую запись под блокировкой этапа.
    const [c1, c2] = await Promise.all([st.db.pool.connect(), st.db.pool.connect()]);
    try {
      const results = await Promise.all(
        [c1, c2].map((c) => c.query(INSERT_REVOCATION, [decision2, st.e.s.ids.manager]).then(() => 'ok', (x: { code?: string }) => x.code ?? 'error')),
      );
      expect(results.sort()).toEqual(['23514', 'ok']);
    } finally {
      c1.release();
      c2.release();
    }
    expect((await stateOf()).closed).toBe(false);
    p2 = await view(st, p2.id, st.e.s.eng1);
    const refused = await release(st, p2, a.body.approval.id as string);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['CALCULATION_PROVISIONAL']);
    expect(
      await pgCode(
        `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
         VALUES ($1, $2, $3, $4, 'production', 0, $5, $5, $5, '{}', $6)`,
        [p2.id, a.body.approval.id, st.e.s.tenderA, st.e.s.stageA, p2.contentHash, st.e.s.ids.eng1],
      ),
    ).toBe('23514');
  });

  it('третье решение — комплект выпущен; отзыв после выпуска проходит, но выпущенное и его основание не меняются; история показывает отзыв', async () => {
    const r = await decide();
    expect(r.status, r.text).toBe(201);
    const decision3 = r.body.active.id as string;
    const p3 = await prepared();
    expect(await closureInputs(p3.id)).toEqual([decision3]);
    const a = await approve(st, p3);
    expect(a.status, a.text).toBe(200);
    const ready = await view(st, p3.id, st.e.s.eng1);
    const rel = await release(st, ready, a.body.approval.id as string);
    expect(rel.status, rel.text).toBe(201);
    const before = await scalar<number>('SELECT count(*)::int AS v FROM release WHERE candidate_id = $1', [p3.id]);
    const revoked = await revoke();
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body.history.map((h: { revocation: unknown }) => h.revocation !== null)).toEqual([true, true, true]);
    expect(await scalar<number>('SELECT count(*)::int AS v FROM release WHERE candidate_id = $1', [p3.id])).toBe(before);
    const after = await view(st, p3.id);
    expect(after).toMatchObject({ status: 'released', release: { id: rel.body.release.id } });
    expect(await closed(p3.id)).toBe(true);
    expect((await stateOf()).closed).toBe(false);
  });
});

describe('новая выгрузка и несведённая сверка', () => {
  let rev4 = '';

  it('новая выгрузка после решений — новая ревизия, не закрытая; решения прежней ревизии остаются в её истории', async () => {
    // Итог источника выше Σ коммерческих строк на 0,5 (допуск сверки — 0,01): ревизия provisional с правилом, но не сведена.
    const t = v2Tender();
    t.cached_grand_total = n(str(dec(t.cached_grand_total.__num).minus(dec('19.5'))));
    st.e.hub.tenders.set(E.v2, t);
    const cap = await captureNow(st.db, st.e.worker, st.e.s.eng1, st.e.s.stageA);
    expect(cap.status, JSON.stringify(cap.failure)).toBe('complete');
    rev4 = cap.revisionId as string;
    expect(rev4).not.toBe(rev);
    expect(await stateOf(rev4)).toMatchObject({ closed: false, canDecide: true, history: [] });
    expect((await stateOf(rev)).history).toHaveLength(3);
  });

  it('KP_TOTAL_UNRECONCILED: решение на новую ревизию снимает CALCULATION_PROVISIONAL, но не несведённую сверку — ни риском, ни согласованием; БД согласна', async () => {
    const [d4a, d4b] = await Promise.all([decide(st.e.s.manager, rev4), decide(st.e.s.manager, rev4)]);
    expect([d4a.status, d4b.status].sort()).toEqual([201, 409]);
    await rerunReview(st);
    const p4 = await prepared();
    expect(await closureInputs(p4.id)).toHaveLength(1);
    expect(await scalar<boolean>('SELECT revision_economics_reconciled($1) AS v', [rev])).toBe(true);
    expect(await scalar<boolean>('SELECT revision_economics_reconciled($1) AS v', [rev4])).toBe(false);
    expect(codes(p4.gate.approve)).toEqual(['KP_TOTAL_UNRECONCILED']);
    expect(await gateProblem(p4.id)).toBe('KP_TOTAL_UNRECONCILED');
    const risk = await acceptRisk(st, p4, { blockerCode: 'KP_TOTAL_UNRECONCILED', subjectType: 'candidate', subjectId: p4.id, reason: 'Итог КП примем на себя' });
    expect(risk.body.current.reason).toBe('risk_not_acceptable');
    const refused = await approve(st, p4);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['KP_TOTAL_UNRECONCILED']);
    // Тестовый комплект на несведённой ревизии не блокируется (блокер боевой).
    const test = await assembled(st);
    expect(codes(test.gate.approve)).not.toContain('KP_TOTAL_UNRECONCILED');
  });

  it('ревизия verified решением не закрывается: API — 409, БД — 23514', async () => {
    const verified = await addVerifiedRevision(st.e);
    expect(await stateOf(verified)).toMatchObject({ kind: 'verified', closed: false, canDecide: false });
    const r = await decide(st.e.s.manager, verified);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('revision_not_provisional');
    expect(await insertDecision(st.e.s.ids.manager, verified)).toBe('23514');
    expect(await scalar<number>('SELECT count(*)::int AS v FROM calculation_closure_decision WHERE calculation_revision_id = $1', [verified])).toBe(0);
  });
});

describe('журнал решений неизменяем', () => {
  it('UPDATE, DELETE и TRUNCATE обеих таблиц: роль приложения — 42501, владелец — 55000 (охранник)', async () => {
    expect(await scalar<number>('SELECT count(*)::int AS v FROM calculation_closure_revocation', [])).toBeGreaterThan(0);
    const owner = new pg.Client({ connectionString: st.db.migratorUrl });
    await owner.connect();
    try {
      for (const t of ['calculation_closure_decision', 'calculation_closure_revocation']) {
        for (const sql of [`UPDATE ${t} SET reason = 'правка'`, `DELETE FROM ${t}`, `TRUNCATE ${t} CASCADE`]) {
          expect(await pgCode(sql, []), sql).toBe('42501');
          expect(await owner.query(sql).then(() => 'ok', (x: { code?: string }) => x.code ?? 'error'), sql).toBe('55000');
        }
      }
    } finally {
      await owner.end();
    }
  });
});
