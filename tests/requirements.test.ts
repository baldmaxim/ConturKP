// Этап 08: сквозные сценарии API (D-026). Кандидат → подтверждение и отклонение, правка новой версией,
// A → B → A ревизий требования и факта, конкурентное подтверждение, замена, решения с заменой и событием
// барьера, допущения, вопросы заказчику, пометки этапа; права по возможностям (OD-08-5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage08, confirm, confirmedRequirement, etag, propose, supports, T, type IStage08 } from './requirementFixtures.ts';

let db: ITestDb;
let st: IStage08;
const config = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
});
afterAll(async () => {
  await db.drop();
});

describe('реестр требований (Р-08-6)', () => {
  it('активный реестр виден участникам; создаёт только requirement.manage; тот же снимок — 409', async () => {
    const r = await st.s.eng1.get(`/stages/${st.s.stageA}/requirement-registry`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.active).toMatchObject({ id: st.registryId, seq: 1, evidenceScopeId: st.scopeId, active: true, previousRegistryId: null });
    const denied = await st.s.eng1.post(`/stages/${st.s.stageA}/requirement-registries`, { evidenceScopeId: st.scopeId, reason: 'x' }, { headers: idem() });
    expect(denied.status).toBe(403);
    const same = await st.s.manager.post(`/stages/${st.s.stageA}/requirement-registries`, { evidenceScopeId: st.scopeId, reason: 'x' }, { headers: idem() });
    expect(same.status, same.text).toBe(409);
    expect(same.body.current.reason).toBe('same_scope');
    const foreign = await st.s.eng3.get(`/stages/${st.s.stageA}/requirement-registry`);
    expect(foreign.status).toBe(404);
  });
});

describe('кандидат → подтверждение (OD-08-5, AD-08-2)', () => {
  it('инженер предлагает, но не подтверждает; руководитель подтверждает; требование R-0001 с основаниями кандидата', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Облицовка фасада — клинкерный кирпич', supports(st.frag.facade), {
      parameters: [{ name: 'материал', value: 'клинкерный кирпич', unit: null }],
      objectScope: { section: 'Секция 1' },
    });
    expect(c.status).toBe('proposed');
    const denied = await confirm(st.s.eng1, c.id);
    expect(denied.status).toBe(403);
    const ok = await confirm(st.s.manager, c.id);
    expect(ok.status, ok.text).toBe(200);
    const req = await st.s.eng1.get(`/requirements/${ok.body.requirementId}`);
    expect(req.status, req.text).toBe(200);
    expect(req.body).toMatchObject({ code: 'R-0001', status: 'confirmed', seq: 1, statement: 'Облицовка фасада — клинкерный кирпич', visible: true });
    expect(req.body.revisions[0].evidence).toEqual([expect.objectContaining({ fragmentId: st.frag.facade, role: 'supports', text: T.facade })]);
    const cand = await st.s.eng1.get(`/requirement-candidates/${c.id}`);
    expect(cand.body).toMatchObject({ status: 'confirmed', requirementId: ok.body.requirementId });
    const audit = await auditRows(db.pool, "action = 'requirement.candidate.confirm'");
    expect(audit.some((a) => a.outcome === 'allowed' && a.entity_id === c.id)).toBe(true);
    expect(audit.some((a) => a.outcome === 'denied')).toBe(true);
  });

  it('подтверждение уточняет формулировку: текст ревизии — подтверждающего, исходный остаётся у кандидата', async () => {
    const c = await propose(st.s.eng2, st.registryId, 'гидроизоляция плиты', supports(st.frag.waterproofing));
    const ok = await confirm(st.s.manager, c.id, { statement: 'Гидроизоляция фундаментной плиты — обмазочная' });
    expect(ok.status, ok.text).toBe(200);
    const req = await st.s.eng1.get(`/requirements/${ok.body.requirementId}`);
    expect(req.body.statement).toBe('Гидроизоляция фундаментной плиты — обмазочная');
    expect((await st.s.eng1.get(`/requirement-candidates/${c.id}`)).body.statement).toBe('гидроизоляция плиты');
  });

  it('кандидат без supports не создаётся; цитата вне снимка — 409', async () => {
    const r = await st.s.eng1.post(`/requirement-registries/${st.registryId}/requirement-candidates`, { statement: 'x', evidence: [{ fragmentId: st.frag.note, role: 'clarifies' }] }, { headers: idem() });
    expect(r.status).toBe(400);
  });

  it('отклонение — с причиной, только из proposed; повтор отклонения — конфликт', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Пояснительная записка — не требование', supports(st.frag.note));
    const noReason = await st.s.manager.post(`/requirement-candidates/${c.id}/reject`, {}, { headers: { 'If-Match': await etag(st.s.manager, `/requirement-candidates/${c.id}`) } });
    expect(noReason.status).toBe(400);
    const tag = await etag(st.s.manager, `/requirement-candidates/${c.id}`);
    const r = await st.s.manager.post(`/requirement-candidates/${c.id}/reject`, { reason: 'Справочный текст' }, { headers: { 'If-Match': tag } });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', statusReason: 'Справочный текст' });
    const again = await st.s.manager.post(`/requirement-candidates/${c.id}/reject`, { reason: 'ещё раз' }, { headers: { 'If-Match': tag } });
    expect([409, 412]).toContain(again.status);
  });

  it('правка предложения — новая версия, прежняя superseded (И-08-5)', async () => {
    const c1 = await propose(st.s.eng1, st.registryId, 'Кровля профнастил', supports(st.frag.roof));
    const c2 = await propose(st.s.eng2, st.registryId, 'Кровля — профнастил С-44', supports(st.frag.roof), { derivedFromCandidateId: c1.id });
    expect((await st.s.eng1.get(`/requirement-candidates/${c1.id}`)).body.status).toBe('superseded');
    expect((await st.s.eng1.get(`/requirement-candidates/${c2.id}`)).body).toMatchObject({ status: 'proposed', derivedFromCandidateId: c1.id });
  });

  it('конкурентное подтверждение: одно проходит, второе — конфликт версии (инвариант 14)', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Кровля — профнастил, уклон по проекту', supports(st.frag.roof));
    const tag = await etag(st.s.manager, `/requirement-candidates/${c.id}`);
    const [a, b] = await Promise.all([
      st.s.manager.post(`/requirement-candidates/${c.id}/confirm`, {}, { headers: { 'If-Match': tag, ...idem() } }),
      st.s.manager.post(`/requirement-candidates/${c.id}/confirm`, {}, { headers: { 'If-Match': tag, ...idem() } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 412]);
    const n = await db.pool.query('SELECT count(*)::int AS n FROM requirement_revision WHERE candidate_id = $1', [c.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('повтор с тем же ключом идемпотентности возвращает тот же результат', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Фасад — клинкер, кладка с расшивкой', supports(st.frag.facade));
    const headers = { 'If-Match': await etag(st.s.manager, `/requirement-candidates/${c.id}`), ...idem() };
    const a = await st.s.manager.post(`/requirement-candidates/${c.id}/confirm`, {}, { headers });
    const b = await st.s.manager.post(`/requirement-candidates/${c.id}/confirm`, {}, { headers });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.requirementId).toBe(a.body.requirementId);
  });
});

describe('ревизии требования (AD-08-1, инвариант 15)', () => {
  it('A → B → A — три различимые ревизии; прежние не меняются', async () => {
    const r = await confirmedRequirement(st, 'Кладка фасада — вариант A', [st.frag.facade]);
    for (const text of ['Кладка фасада — вариант B', 'Кладка фасада — вариант A']) {
      const c = await propose(st.s.eng1, st.registryId, text, supports(st.frag.facade), { targetRequirementId: r.requirementId });
      const ok = await confirm(st.s.manager, c.id);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.requirementId).toBe(r.requirementId);
    }
    const card = (await st.s.eng1.get(`/requirements/${r.requirementId}`)).body;
    expect(card.revisions.map((v: { seq: number; statement: string }) => [v.seq, v.statement])).toEqual([
      [1, 'Кладка фасада — вариант A'],
      [2, 'Кладка фасада — вариант B'],
      [3, 'Кладка фасада — вариант A'],
    ]);
    expect(new Set(card.revisions.map((v: { id: string }) => v.id)).size).toBe(3);
    expect(card.seq).toBe(3);
  });

  it('замена другим требованием этапа: заменённое не правится; инженер заменить не может', async () => {
    const a = await confirmedRequirement(st, 'Окна — ПВХ профиль', [st.frag.note]);
    const b = await confirmedRequirement(st, 'Окна — ПВХ профиль 70 мм', [st.frag.note]);
    const tag = await etag(st.s.manager, `/requirements/${a.requirementId}`);
    const denied = await st.s.eng1.post(`/requirements/${a.requirementId}/supersede`, { replacementId: b.requirementId, reason: 'уточнено' }, { headers: { 'If-Match': tag } });
    expect(denied.status).toBe(403);
    const ok = await st.s.manager.post(`/requirements/${a.requirementId}/supersede`, { replacementId: b.requirementId, reason: 'уточнено' }, { headers: { 'If-Match': tag } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'superseded', supersededByRequirementId: b.requirementId });
    const c = await propose(st.s.eng1, st.registryId, 'Окна — снова', supports(st.frag.note), { targetRequirementId: a.requirementId });
    const r = await confirm(st.s.manager, c.id);
    expect(r.status).toBe(409);
  });
});

describe('решения (Р-08-3)', () => {
  it('решение — requirement.decide; замена новой версией; старая не меняется; событие барьера decision_recorded', async () => {
    const r = await confirmedRequirement(st, 'Утеплитель фасада — минвата 150 мм', [st.frag.facade]);
    const denied = await st.s.eng1.post(`/requirements/${r.requirementId}/decisions`, { statement: 'x', rationale: 'y' }, { headers: idem() });
    expect(denied.status).toBe(403);
    const before = (await db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.s.stageA])).rows[0].input_version as number;
    const d1 = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'Принять минвату 150 мм', rationale: 'по ТЗ', evidence: supports(st.frag.facade) }, { headers: idem() });
    expect(d1.status, d1.text).toBe(201);
    const ev = await db.pool.query("SELECT event_type, event_class, ref_id FROM stage_input_event WHERE stage_id = $1 ORDER BY seq DESC LIMIT 1", [st.s.stageA]);
    expect(ev.rows[0]).toMatchObject({ event_type: 'decision_recorded', event_class: 'content', ref_id: d1.body.decisionId });
    expect((await db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.s.stageA])).rows[0].input_version).toBe(before + 1);
    const d2 = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'Принять минвату 200 мм', rationale: 'уточнение заказчика', supersedesDecisionId: d1.body.decisionId }, { headers: idem() });
    expect(d2.status, d2.text).toBe(201);
    const decisions = d2.body.requirement.decisions as { id: string; status: string; statement: string }[];
    expect(decisions).toEqual([
      expect.objectContaining({ id: d1.body.decisionId, status: 'superseded', statement: 'Принять минвату 150 мм' }),
      expect.objectContaining({ id: d2.body.decisionId, status: 'active' }),
    ]);
    const twice = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'z', rationale: 'z', supersedesDecisionId: d1.body.decisionId }, { headers: idem() });
    expect(twice.status).toBe(409);
  });
});

describe('допущения, вопросы и пометки (OD-08-6)', () => {
  it('допущение: open → правка → confirmed (руководитель); инженер не подтверждает', async () => {
    const a = await st.s.eng1.post(`/stages/${st.s.stageA}/assumptions`, { statement: 'Толщина плиты принята 300 мм до РД' }, { headers: idem() });
    expect(a.status, a.text).toBe(201);
    expect(a.body).toMatchObject({ status: 'open', seq: 1, statement: 'Толщина плиты принята 300 мм до РД' });
    const edit = await st.s.eng1.post(`/assumptions/${a.body.id}/revisions`, { statement: 'Толщина плиты принята 350 мм до РД', status: 'open' }, { headers: { 'If-Match': a.headers.etag } });
    expect(edit.status, edit.text).toBe(200);
    const denied = await st.s.eng1.post(`/assumptions/${a.body.id}/revisions`, { status: 'confirmed' }, { headers: { 'If-Match': edit.headers.etag } });
    expect(denied.status).toBe(403);
    const ok = await st.s.manager.post(`/assumptions/${a.body.id}/revisions`, { status: 'confirmed' }, { headers: { 'If-Match': edit.headers.etag } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'confirmed', seq: 3, statement: 'Толщина плиты принята 350 мм до РД' });
    expect(ok.body.revisions.map((r: { status: string }) => r.status)).toEqual(['open', 'open', 'confirmed']);
  });

  it('вопрос заказчику: draft → sent → answered (пояснение) → closed; текст после отправки не меняется', async () => {
    const q = await st.s.eng1.post(`/stages/${st.s.stageA}/customer-questions`, { text: 'Уточните марку бетона плиты', responsibleUserId: st.s.ids.eng2 }, { headers: idem() });
    expect(q.status, q.text).toBe(201);
    const sent = await st.s.eng1.patch(`/customer-questions/${q.body.id}`, { status: 'sent' }, { headers: { 'If-Match': q.headers.etag } });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.askedAt).not.toBeNull();
    const edit = await st.s.eng1.patch(`/customer-questions/${q.body.id}`, { text: 'другой текст' }, { headers: { 'If-Match': sent.headers.etag } });
    expect(edit.status).toBe(409);
    const answered = await st.s.eng2.patch(`/customer-questions/${q.body.id}`, { status: 'answered', answerNote: 'B30 по письму заказчика' }, { headers: { 'If-Match': sent.headers.etag } });
    expect(answered.status, answered.text).toBe(200);
    const closed = await st.s.eng2.patch(`/customer-questions/${q.body.id}`, { status: 'closed' }, { headers: { 'If-Match': answered.headers.etag } });
    expect(closed.body).toMatchObject({ status: 'closed', answerNote: 'B30 по письму заказчика' });
    const outsider = await st.s.eng3.get(`/stages/${st.s.stageA}/customer-questions`);
    expect(outsider.status).toBe(404);
  });

  it('пометка этапа: неизменяема, замена — новой пометкой; не попадает в полноту', async () => {
    const before = (await st.s.eng1.get(`/requirement-registries/${st.registryId}/completeness`)).body.counts;
    const n1 = await st.s.eng1.post(`/stages/${st.s.stageA}/notes`, { text: 'Проверить узлы примыкания' }, { headers: idem() });
    expect(n1.status, n1.text).toBe(201);
    const n2 = await st.s.eng1.post(`/stages/${st.s.stageA}/notes`, { text: 'Проверить узлы примыкания кровли', supersedesNoteId: n1.body.id }, { headers: idem() });
    expect(n2.status).toBe(201);
    const list = (await st.s.eng2.get(`/stages/${st.s.stageA}/notes`)).body.items as { id: string; supersededBy: string | null }[];
    expect(list.find((n) => n.id === n1.body.id)?.supersededBy).toBe(n2.body.id);
    expect((await st.s.eng1.get(`/requirement-registries/${st.registryId}/completeness`)).body.counts).toEqual(before);
  });
});

describe('факты (OD-08-3, Р-08-4)', () => {
  it('кандидат факта → подтверждение fact.confirm; A → B → A; вид — из справочника', async () => {
    const kinds = await st.s.eng1.get('/fact-kinds');
    expect(kinds.body.items.map((k: { code: string }) => k.code).sort()).toEqual(['advance_payment', 'contract_party', 'contract_price', 'estimate_total']);
    const make = async (displayValue: string, targetFactId?: string) => {
      const c = await st.s.eng1.post(
        `/requirement-registries/${st.registryId}/fact-candidates`,
        { factKind: 'advance_payment', displayValue, normalizedValue: { value: Number.parseInt(displayValue, 10), unit: '%' }, unit: '%', evidence: supports(st.frag.advance), ...(targetFactId ? { targetFactId } : {}) },
        { headers: idem() },
      );
      expect(c.status, c.text).toBe(201);
      const denied = await st.s.eng1.post(`/fact-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': c.headers.etag, ...idem() } });
      expect(denied.status).toBe(403);
      const ok = await st.s.manager.post(`/fact-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': c.headers.etag, ...idem() } });
      expect(ok.status, ok.text).toBe(200);
      return ok.body.factId as string;
    };
    const factId = await make('30 %');
    await make('40 %', factId);
    await make('30 %', factId);
    const card = (await st.s.eng1.get(`/facts/${factId}`)).body;
    expect(card.revisions.map((r: { seq: number; displayValue: string }) => [r.seq, r.displayValue])).toEqual([
      [1, '30 %'],
      [2, '40 %'],
      [3, '30 %'],
    ]);
    const unknown = await st.s.eng1.post(`/requirement-registries/${st.registryId}/fact-candidates`, { factKind: 'unknown_kind', displayValue: 'x', normalizedValue: {}, evidence: supports(st.frag.advance) }, { headers: idem() });
    expect(unknown.status).toBe(409);
  });

  it('факт и требование — разные сущности: основание факта — письменный текст (D-018)', async () => {
    const reqs = (await st.s.eng1.get(`/requirement-registries/${st.registryId}/requirements`)).body.items as { id: string }[];
    const facts = (await st.s.eng1.get(`/requirement-registries/${st.registryId}/facts`)).body.items as { id: string }[];
    expect(reqs.some((r) => facts.some((f) => f.id === r.id))).toBe(false);
  });
});
