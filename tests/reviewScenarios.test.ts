// Этап 09: контрольные сценарии задания (docs/spec/prompts/stage-09.md «Проверки»; проект — 09-review-checks-design.md §10).
// Светильник №1/№2 (A01), электроэнергия в договоре против расчёта (A02), конфликт двух ответов (A04), молчание заказчика,
// комплексная расценка (A05), неопределённость ПД (A06), количества и дубли (В-09-6). Расчёт — поддельный TenderHub
// (VERIFIED_FIXTURE), модель — поддельная: проверяется механизм, а не качество (D-029 В-09-5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import {
  buildStage09,
  checkOf,
  closeHub,
  cover,
  findings,
  line,
  requirement,
  RT,
  runReview,
  TXT,
  type IRunView,
  type IStage09,
} from './reviewFixtures.ts';

let db: ITestDb;
let st: IStage09;
let run: IRunView;
const req: Record<string, { requirementId: string; revisionId: string; code: string }> = {};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  req.lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, req.lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  req.masonry = await requirement(st, 'Кладка стен — 55 м3', [{ name: 'Объём кладки', value: '55', unit: 'м3' }], [st.frag.masonry]);
  await cover(st, req.masonry.revisionId, { state: 'covered', objects: [line(st, RT.masonry, RT.masonryLine)] });
  req.facade = await requirement(st, 'Облицовка фасада — клинкерный кирпич', [{ name: 'Материал облицовки', value: 'клинкерный кирпич' }], [st.frag.facade]);
  await cover(st, req.facade.revisionId, { state: 'covered', objects: [line(st, RT.facade, null)] });
  req.power = await requirement(st, 'Временное электроснабжение — за счёт генподрядчика', [], [st.frag.power]);
  await cover(st, req.power.revisionId, { state: 'not_applicable', reason: 'Электроснабжение площадки — за счёт заказчика' });
  req.grey = await requirement(st, 'Цвет фасада — серый', [{ name: 'Цвет фасада', value: 'серый' }], [st.frag.grey]);
  req.white = await requirement(st, 'Цвет фасада — белый', [{ name: 'Цвет фасада', value: 'белый' }], [st.frag.white], 'Ответ 2 противоречит ответу 1');
  run = await runReview(st);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('прогон проверки: закреплённые входы и исходы', () => {
  it('входы закреплены: снимок, реестр, ревизия расчёта, приоритет, версии правил и модели', () => {
    expect(run.status).toBe('completed_with_gaps');
    expect(run.inputs).toMatchObject({ evidenceScopeId: st.scopeId, registryId: st.registryId, calculationRevisionId: st.calcRevisionId, rulesVersion: 'rules/09-1' });
    expect(run.checks).toHaveLength(12);
    expect(run.checks.every((c) => c.outcome !== null)).toBe(true);
    // Реестр не пройден — неполнота, а не «всё проверено» (A44, I18).
    expect(checkOf(run, 'registry').outcome).toBe('incomplete');
    expect(run.summary.kind).not.toBe('clean');
  });
});

describe('A01: светильник №1 / №2', () => {
  it('параметр требования не найден в строке расчёта: обе цитаты, критичность по таблице владельца', async () => {
    const all = await findings(st);
    const f = all.find((x) => x.kind === 'parameter_mismatch' && x.requirements.includes(req.lamp!.code))!;
    expect(f, JSON.stringify(all.map((x) => [x.kind, x.title]))).toBeTruthy();
    expect(f).toMatchObject({ severity: 'major', confidence: 'medium', status: 'open', restricted: false });
    const d = await st.s.eng1.get(`/findings/${f.id}`);
    expect(d.status, d.text).toBe(200);
    const left = d.body.evidence.find((e: { side: string; type: string }) => e.side === 'left' && e.type === 'fragment');
    const right = d.body.evidence.find((e: { side: string; type: string }) => e.side === 'right' && e.type === 'calculation_object');
    expect(left.fragment.text).toBe(TXT.lamp);
    expect(right.calculation.text).toBe('Светильник светодиодный №2');
  });

  it('разногласие: четыре оси независимы; «согласовано письмом» не становится «закреплено в ТЗ»', async () => {
    const f = (await findings(st)).find((x) => x.kind === 'parameter_mismatch' && x.requirements.includes(req.lamp!.code))!;
    const created = await st.s.eng1.post(`/findings/${f.id}/discrepancy`, { topic: 'Светильник' }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    const dId = created.body.discrepancy.id as string;
    expect(created.body.discrepancy.axes).toMatchObject({
      customer_position: { value: 'unknown' },
      calculation: { value: 'not_reflected' },
      proposal: { value: 'not_reflected' },
      documents: { value: 'not_fixed' },
    });
    const axis = (axisName: string, value: string, bases: object[] = []) =>
      st.s.eng1.post(`/discrepancies/${dId}/status-events`, { axis: axisName, value, reason: 'по письму заказчика', bases }, { headers: idem() });
    // Письмо — письменное основание согласия.
    const agreed = await axis('customer_position', 'agreed_in_writing', [{ type: 'fragment', id: st.frag.letter }]);
    expect(agreed.status, agreed.text).toBe(201);
    expect((await axis('calculation', 'reflected')).status).toBe(201);
    // Письмо не закрепляет условие в ТЗ (I08, A01): «закреплено в ТЗ» — только с основанием из ТЗ.
    const fixed = await axis('documents', 'fixed_in_tz', [{ type: 'fragment', id: st.frag.letter }]);
    expect(fixed.status, fixed.text).toBe(409);
    const view = (await st.s.eng1.get(`/findings/${f.id}`)).body.discrepancy;
    expect(view.axes).toMatchObject({
      customer_position: { value: 'agreed_in_writing' },
      calculation: { value: 'reflected' },
      proposal: { value: 'not_reflected' },
      documents: { value: 'not_fixed' },
    });
    expect(view.history.map((h: { axis: string; value: string }) => `${h.axis}=${h.value}`)).toEqual(['customer_position=agreed_in_writing', 'calculation=reflected']);
    // Замечание система не закрывает: статус прежний.
    expect((await st.s.eng1.get(`/findings/${f.id}`)).body.status).toBe('open');
  });
});

describe('A02: электроэнергия в договоре против расчёта', () => {
  it('обязательство договора «не применимо» в расчёте — вопрос инженеру и руководителю, без юридического вывода', async () => {
    const f = (await findings(st)).find((x) => x.kind === 'contract_obligation' && x.requirements.includes(req.power!.code))!;
    expect(f).toBeTruthy();
    const d = (await st.s.eng1.get(`/findings/${f.id}`)).body;
    expect(d.action).toMatch(/Вопрос инженеру и руководителю/u);
    expect(d.title).toMatch(/не применимо/u);
    expect(`${d.title} ${d.detail ?? ''} ${d.action}`).not.toMatch(/наруш|незаконн|обязан выплат|штраф/iu);
    const left = d.evidence.find((e: { side: string; type: string }) => e.side === 'left' && e.type === 'fragment');
    expect(left.fragment.text).toBe(TXT.power);
    expect(d.severity).toBe('major');
  });
});

describe('A04: конфликт двух ответов заказчика', () => {
  it('оба основания видны; приоритет одного вида не различает; поздний ответ конфликт не закрывает', async () => {
    const f = (await findings(st)).find((x) => x.kind === 'source_conflict' && x.requirements.includes(req.grey!.code) && x.requirements.includes(req.white!.code))!;
    expect(f).toBeTruthy();
    expect(f.suggestedSide).toBeNull();
    const d = (await st.s.eng1.get(`/findings/${f.id}`)).body;
    const texts = d.evidence.filter((e: { type: string }) => e.type === 'fragment').map((e: { side: string; fragment: { text: string } }) => `${e.side}:${e.fragment.text}`);
    expect(texts).toEqual(expect.arrayContaining([`left:${TXT.grey}`, `right:${TXT.white}`]));
    // Повторная проверка: конфликт остаётся тем же замечанием (вхождение), не закрывается и не дублируется.
    const again = await runReview(st);
    const after = (await findings(st)).filter((x) => x.kind === 'source_conflict' && x.requirements.includes(req.grey!.code));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('open');
    expect(again.id).not.toBe(run.id);
  });
});

describe('молчание заказчика', () => {
  it('вопрос без ответа — замечание; ось позиции заказчика сама не меняется', async () => {
    const q = await st.s.eng1.post(`/stages/${st.s.stageA}/customer-questions`, { text: 'Подтвердите цвет фасада письмом.' }, { headers: idem() });
    expect(q.status, q.text).toBe(201);
    const sent = await st.s.eng1.patch(`/customer-questions/${q.body.id}`, { status: 'sent', askedAt: '2026-09-20T10:00:00Z' }, { headers: { 'If-Match': q.headers.etag as string } });
    expect(sent.status, sent.text).toBe(200);
    const r = await runReview(st);
    expect(checkOf(r, 'customer_silence').outcome).toBe('failed');
    const silence = (await findings(st)).filter((x) => x.kind === 'customer_silence');
    // Открытый вопрос Q&A и отправленный вопрос заказчику.
    expect(silence.length).toBe(2);
    expect(silence.every((x) => x.severity === 'minor' && x.status === 'open')).toBe(true);
    const events = await db.pool.query("SELECT 1 FROM discrepancy_status_event WHERE axis = 'customer_position' AND value <> 'agreed_in_writing'");
    expect(events.rowCount).toBe(0);
  });
});

describe('количества, комплексная расценка, неопределённость ПД', () => {
  it('количество требования ≠ объём строки той же единицы; дубль позиции в разделе', async () => {
    const all = await findings(st);
    const q = all.find((x) => x.kind === 'quantity_mismatch' && x.requirements.includes(req.masonry!.code))!;
    expect(q.title).toMatch(/55/u);
    expect(q.title).toMatch(/50/u);
    expect(all.some((x) => x.kind === 'duplicate_position' && x.title.includes('Кладка стен'))).toBe(true);
  });

  it('A05: комплексная расценка без строки — параметр не проверяется, ложного расхождения нет', async () => {
    const all = await findings(st);
    expect(all.some((x) => x.kind === 'parameter_mismatch' && x.requirements.includes(req.facade!.code))).toBe(false);
    expect(checkOf(run, 'parameters').counts.complexRate).toBeGreaterThan(0);
  });

  it('A06: «уточняется в РД» без допущения — замечание; с допущением — нет', async () => {
    const before = (await findings(st)).filter((x) => x.kind === 'pd_uncertainty');
    expect(before).toHaveLength(1);
    const a = await st.s.eng1.post(`/stages/${st.s.stageA}/assumptions`, { statement: 'Марка бетона принята B25 до выхода РД', evidence: [{ fragmentId: st.frag.pd, role: 'supports' }] }, { headers: idem() });
    expect(a.status, a.text).toBe(201);
    const r = await runReview(st);
    expect(checkOf(r, 'pd_uncertainty').outcome).toBe('passed');
  });
});
