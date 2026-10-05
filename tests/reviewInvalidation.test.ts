// Этап 09: инвалидация по зависимостям и принятый риск (09-review-checks-design.md §5.4, §3.2; D-029). Новая редакция
// основания после закрытия замечания — «устарело» с причиной, решение по нему (включая принятие риска) и событие оси —
// с отметкой недействительности, история сохраняется; область изменения не определена — консервативно по семействам;
// прежний отчёт открывается как был, с пометкой «устарел». Принятие риска — руководитель с причиной (A45).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { eml, importEml, linkMail } from './mailFixtures.ts';
import { buildStage09, closeHub, cover, findings, line, requirement, RT, runReview, type IRunView, type IStage09 } from './reviewFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage09;
let first: IRunView;
const req: Record<string, { requirementId: string; revisionId: string; code: string }> = {};

const detail = async (id: string) => {
  const r = await st.s.eng1.get(`/findings/${id}`);
  expect(r.status, r.text).toBe(200);
  return r.body;
};
const transition = async (client: IStage09['s']['eng1'], id: string, body: object) =>
  client.post(`/findings/${id}/transitions`, body, { headers: { 'If-Match': (await client.get(`/findings/${id}`)).headers.etag as string, ...idem() } });

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  req.lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, req.lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  req.masonry = await requirement(st, 'Кладка стен — 55 м3', [{ name: 'Объём кладки', value: '55', unit: 'м3' }], [st.frag.masonry]);
  await cover(st, req.masonry.revisionId, { state: 'covered', objects: [line(st, RT.masonry, RT.masonryLine)] });
  first = await runReview(st);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('A45: принятый риск', () => {
  it('инженер риск не принимает; техническое замечание риском не принимается; руководитель — с причиной и автором', async () => {
    const all = await findings(st);
    const q = all.find((f) => f.kind === 'quantity_mismatch' && f.requirements.includes(req.masonry!.code))!;
    const registry = all.find((f) => f.kind === 'registry_incomplete')!;
    const body = { to: 'accepted_risk', reason: 'Объём уточнится при выходе РД, расхождение несущественно', statement: 'Принять риск расхождения объёма кладки' };
    expect((await transition(st.s.eng1, q.id, body)).status).toBe(403);
    const tech = await transition(st.s.manager, registry.id, body);
    expect(tech.status, tech.text).toBe(409);
    expect(tech.body.current.reason).toBe('risk_not_acceptable');
    const ok = await transition(st.s.manager, q.id, body);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('accepted_risk');
    expect(ok.body.severity).toBe('major');
    expect(ok.body.decisions).toEqual([expect.objectContaining({ type: 'finding_risk_acceptance', decidedBy: 'Руководитель', rationale: body.reason, invalidatedReason: null })]);
    // Принятый риск — не «пройдено»: сводка прогона не «замечаний нет».
    const v = (await st.s.eng1.get(`/review-runs/${first.id}`)).body;
    expect(v.findings.byStatus.accepted_risk).toBe(1);
    expect(v.summary.kind).not.toBe('clean');
  });
});

describe('новая редакция после закрытия замечания', () => {
  let lampId: string;
  let axisEventId: string;

  it('замечание решено с решением; разногласие с основанием из ТЗ', async () => {
    lampId = (await findings(st)).find((f) => f.kind === 'parameter_mismatch' && f.requirements.includes(req.lamp!.code))!.id;
    const disc = await st.s.eng1.post(`/findings/${lampId}/discrepancy`, { topic: 'Светильник' }, { headers: idem() });
    expect(disc.status, disc.text).toBe(201);
    const ev = await st.s.eng1.post(
      `/discrepancies/${disc.body.discrepancy.id}/status-events`,
      { axis: 'calculation', value: 'reflected', reason: 'в расчёте №2 по письму', bases: [{ type: 'fragment', id: st.frag.lamp }] },
      { headers: idem() },
    );
    expect(ev.status, ev.text).toBe(201);
    axisEventId = ev.body.discrepancy.history[0].id;
    const ok = await transition(st.s.eng1, lampId, { to: 'resolved', reason: 'Замена согласована письмом', statement: 'Применять светильник №2' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('resolved');
  });

  it('новая редакция ТЗ: замечание «устарело» с причиной, решения и событие оси отмечены, история сохранена', async () => {
    const rev2 = await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ТЗ.pdf');
    expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [rev2])).rows[0].supersedes_revision_id).toBe(st.tzRev);
    await st.worker.maintain({ checkModel: false });
    await drain(st.worker);
    const lamp = await detail(lampId);
    expect(lamp.status).toBe('stale');
    expect(lamp.events.map((e: { kind: string; to: string }) => `${e.kind}:${e.to}`)).toEqual(['created:open', 'status:resolved', 'status:stale']);
    const staleEvent = lamp.events.at(-1);
    expect(staleEvent.actor).toBe('система');
    expect(staleEvent.reason).toMatch(/новая редакция 2 документа «ТЗ\.pdf»/u);
    expect(lamp.invalidations[0]).toMatchObject({ mode: 'exact', eventType: 'document_revision_registered' });
    // Решение по замечанию не удалено: оно в истории и отмечено недействительным с причиной.
    expect(lamp.decisions).toEqual([expect.objectContaining({ type: 'finding_resolution', statement: 'Применять светильник №2', invalidatedReason: expect.stringMatching(/новая редакция/u) })]);
    const axis = lamp.discrepancy.history.find((h: { id: string }) => h.id === axisEventId);
    expect(axis.invalidatedReason).toMatch(/новая редакция/u);
    expect(lamp.discrepancy.axes.calculation.value).toBe('reflected');
    // Принятый риск по основанию из той же редакции тоже недействителен (D-029).
    const q = (await findings(st)).find((f) => f.kind === 'quantity_mismatch' && f.requirements.includes(req.masonry!.code))!;
    const qd = await detail(q.id);
    expect(qd.status).toBe('stale');
    expect(qd.decisions[0]).toMatchObject({ type: 'finding_risk_acceptance', invalidatedReason: expect.stringMatching(/новая редакция/u) });
    const p = await db.pool.query("SELECT mode FROM stage_input_event_processing p JOIN stage_input_event e ON e.id = p.event_id WHERE e.event_type = 'document_revision_registered' AND e.ref_id = $1", [rev2]);
    expect(p.rows).toEqual([{ mode: 'exact' }]);
  });

  it('прежний отчёт открывается как был, с пометкой «устарел» и причиной', async () => {
    const v = (await st.s.eng1.get(`/review-runs/${first.id}`)).body;
    expect(v.checks).toEqual(first.checks);
    expect(v.freshness.outdated).toBe(true);
    expect(v.freshness.reasons.join(' ')).toMatch(/поступили источники/u);
    expect(v.summary.kind).toBe('outdated');
  });

  it('повторная проверка на прежнем снимке: новое замечание сразу «устарело» (R09-01); пересмотр — человеком, одно действующее на условие', async () => {
    const r = await runReview(st);
    const lampNow = (await findings(st)).filter((f) => f.kind === 'parameter_mismatch' && f.requirements.includes(req.lamp!.code));
    // Снимок прогона старше новой редакции ТЗ: результат по прежней редакции действующим не становится.
    expect(lampNow.map((f) => f.status)).toEqual(['stale', 'stale']);
    expect(r.freshness.outdated).toBe(true);
    const second = lampNow.find((f) => f.id !== lampId)!;
    const d = (await st.s.eng1.get(`/findings/${second.id}`)).body;
    expect(d.invalidations[0]).toMatchObject({ mode: 'exact', eventType: 'document_revision_registered' });
    expect(d.events.map((e: { kind: string; to: string }) => `${e.kind}:${e.to}`)).toEqual(['created:open', 'status:stale']);
    // Пересмотр человеком: одно из устаревших открыто; второе того же условия — конфликт, а не дубль.
    expect((await transition(st.s.eng1, lampId, { to: 'open', reason: 'пересмотр' })).status).toBe(200);
    const reopen = await transition(st.s.eng1, second.id, { to: 'open', reason: 'пересмотр' });
    expect(reopen.status, reopen.text).toBe(409);
    // Решённое замечание напрямую не открывается.
    const resolvedOther = (await findings(st)).find((f) => f.kind === 'duplicate_position')!;
    expect((await transition(st.s.eng1, resolvedOther.id, { to: 'rejected', reason: 'Разные захватки' })).status).toBe(200);
    expect((await transition(st.s.eng1, resolvedOther.id, { to: 'open', reason: 'вернуть' })).status).toBe(409);
  });
});

describe('консервативная инвалидация', () => {
  it('новое письмо: область не определена — молчание и конфликты устаревают с причиной, количества — нет', async () => {
    const before = await findings(st);
    const silence = before.filter((f) => f.kind === 'customer_silence' && f.status === 'open');
    const dup = before.find((f) => f.kind === 'duplicate_position')!;
    expect(silence.length).toBeGreaterThan(0);
    const box = (await db.pool.query<{ id: string }>('SELECT id FROM mailbox LIMIT 1')).rows[0]!.id;
    const letter = await importEml(st.s.eng1, st.worker, box, eml({ messageId: 'answer-09@example.test', subject: 'Сроки', text: 'Срок поставки светильников — 30 дней.' }));
    await linkMail(st.s.eng1, letter.messageId!, st.s.tenderA, st.s.stageA);
    await st.worker.maintain({ checkModel: false });
    await drain(st.worker);
    for (const f of silence) {
      const d = await detail(f.id);
      expect(d.status).toBe('stale');
      expect(d.invalidations.at(-1)).toMatchObject({ mode: 'conservative', eventType: 'communication_linked' });
      expect(d.invalidations.at(-1).reason).toMatch(/область влияния не определена/u);
    }
    expect((await detail(dup.id)).status).toBe(dup.status);
  });
});
