// Этап 09: права и закрытость (ADR-006, R08-02, A12, A25). Чужой тендер и администратор без назначения — как
// несуществующее; инженер не принимает риск и не меняет приоритет; текст замечания, оснований и осей — только тому,
// кто читает все основания (письмо без права на ящик — метаданные без текста); каждый отказ — в журнале.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage09, closeHub, cover, findings, line, requirement, RT, runReview, TXT, type IStage09 } from './reviewFixtures.ts';

let db: ITestDb;
let st: IStage09;
let lampFinding: string;
let mailFinding: string;
let runId: string;

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  const lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  runId = (await runReview(st)).id;
  lampFinding = (await findings(st)).find((f) => f.kind === 'parameter_mismatch')!.id;
  // Замечание человека по письму: основание читает только тот, у кого есть mail.read на ящик.
  const h = await st.s.eng1.post(
    `/stages/${st.s.stageA}/findings`,
    { title: 'Письмо о замене светильника не отражено в ТЗ', detail: 'см. письмо', severity: 'major', confidence: 'medium', action: 'Закрепить в ТЗ', evidence: [{ side: 'left', fragmentId: st.frag.letter }] },
    { headers: idem() },
  );
  expect(h.status, h.text).toBe(201);
  mailFinding = h.body.id;
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('область тендера', () => {
  it('инженер другого тендера: прогоны, замечания, разногласия, приоритет — как несуществующее', async () => {
    for (const path of [`/stages/${st.s.stageA}/review-runs`, `/review-runs/${runId}`, `/stages/${st.s.stageA}/findings`, `/findings/${lampFinding}`, `/stages/${st.s.stageA}/discrepancies`]) {
      expect((await st.s.eng3.get(path)).status, path).toBe(404);
    }
    expect((await st.s.eng3.post(`/stages/${st.s.stageA}/review-runs`, {}, { headers: idem() })).status).toBe(404);
    expect((await st.s.eng3.post(`/findings/${lampFinding}/discrepancy`, { topic: 'x' }, { headers: idem() })).status).toBe(404);
    const denied = await auditRows(db.pool, "action = 'finding.read' AND outcome = 'denied'");
    expect(denied.length).toBeGreaterThan(0);
  });

  it('администратор без назначения содержимого не видит', async () => {
    expect((await st.s.admin.get(`/findings/${lampFinding}`)).status).toBe(404);
    expect((await st.s.admin.get(`/stages/${st.s.stageA}/findings`)).status).toBe(404);
  });

  it('инженер: риск и приоритет — 403 с записью в журнале; руководитель — может', async () => {
    const etag = (await st.s.eng1.get(`/findings/${lampFinding}`)).headers.etag as string;
    const r = await st.s.eng1.post(`/findings/${lampFinding}/transitions`, { to: 'accepted_risk', reason: 'x', statement: 'y' }, { headers: { 'If-Match': etag, ...idem() } });
    expect(r.status).toBe(403);
    const audit = await auditRows(db.pool, "action = 'finding.transition' AND outcome = 'denied'");
    expect(audit.some((a) => (a.details as { capability?: string }).capability === 'finding.accept_risk')).toBe(true);
    const kinds = ['tz', 'contract', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'];
    expect((await st.s.eng1.post(`/tenders/${st.s.tenderA}/source-priority`, { kinds, reason: 'x' }, { headers: idem() })).status).toBe(403);
    const view = (await st.s.eng1.get(`/stages/${st.s.stageA}/findings`)).body;
    expect(view).toMatchObject({ canWrite: true, canAcceptRisk: false, canDecide: false });
    const mgr = (await st.s.manager.get(`/stages/${st.s.stageA}/findings`)).body;
    expect(mgr).toMatchObject({ canWrite: true, canAcceptRisk: true, canDecide: true });
  });

  it('If-Match обязателен; устаревшая версия — 412', async () => {
    const no = await st.s.eng1.post(`/findings/${lampFinding}/transitions`, { to: 'rejected', reason: 'x' }, { headers: idem() });
    expect(no.status).toBe(428);
    const stale = await st.s.eng1.post(`/findings/${lampFinding}/transitions`, { to: 'rejected', reason: 'x' }, { headers: { 'If-Match': `"${lampFinding}:999"`, ...idem() } });
    expect(stale.status).toBe(412);
  });
});

describe('закрытость производного текста (R08-02)', () => {
  it('инженер без права на ящик: замечание по письму — без текста, основание без цитаты; изменить его нельзя', async () => {
    const own = (await st.s.eng1.get(`/findings/${mailFinding}`)).body;
    expect(own).toMatchObject({ restricted: false, title: 'Письмо о замене светильника не отражено в ТЗ', detail: 'см. письмо' });
    expect(own.evidence[0].fragment.text).toBe(TXT.letter);
    const other = await st.s.eng2.get(`/findings/${mailFinding}`);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ restricted: true, title: 'Замечание человека', detail: null, action: null });
    expect(other.body.evidence[0].fragment).toMatchObject({ readable: false, text: null });
    expect(JSON.stringify(other.body)).not.toContain('Согласовываем замену');
    const etag = other.headers.etag as string;
    const t = await st.s.eng2.post(`/findings/${mailFinding}/transitions`, { to: 'rejected', reason: 'x' }, { headers: { 'If-Match': etag, ...idem() } });
    expect(t.status).toBe(409);
    expect(t.body.current.reason).toBe('restricted_fragments');
    const list = (await st.s.eng2.get(`/stages/${st.s.stageA}/findings`)).body.items as { id: string; restricted: boolean; title: string }[];
    expect(list.find((f) => f.id === mailFinding)).toMatchObject({ restricted: true, title: 'Замечание человека' });
  });

  it('разногласие с основанием-письмом: ось видна, тема и причины — нет', async () => {
    const d = await st.s.eng1.post(`/findings/${lampFinding}/discrepancy`, { topic: 'Светильник: согласовано письмом' }, { headers: idem() });
    expect(d.status, d.text).toBe(201);
    const ev = await st.s.eng1.post(
      `/discrepancies/${d.body.discrepancy.id}/status-events`,
      { axis: 'customer_position', value: 'agreed_in_writing', reason: 'Письмо: согласовываем №2', bases: [{ type: 'fragment', id: st.frag.letter }] },
      { headers: idem() },
    );
    expect(ev.status, ev.text).toBe(201);
    const list = (await st.s.eng2.get(`/stages/${st.s.stageA}/discrepancies`)).body.items[0];
    expect(list).toMatchObject({ restricted: true, topic: 'Разногласие (основания недоступны)' });
    expect(list.axes.customer_position.value).toBe('agreed_in_writing');
    expect(list.history[0].reason).toBeNull();
    const mine = (await st.s.eng1.get(`/stages/${st.s.stageA}/discrepancies`)).body.items[0];
    expect(mine).toMatchObject({ restricted: false, topic: 'Светильник: согласовано письмом' });
    expect(mine.history[0].reason).toBe('Письмо: согласовываем №2');
  });

  it('замечание человека по фрагменту вне снимков этапа — отказ', async () => {
    const foreign = (await db.pool.query("SELECT id FROM evidence_fragment WHERE origin = 'recognized_text' AND tender_id <> $1 LIMIT 1", [st.s.tenderA])).rows[0]?.id;
    const fragment = foreign ?? '00000000-0000-4000-8000-000000000002';
    const r = await st.s.eng1.post(`/stages/${st.s.stageA}/findings`, { title: 'Чужое', severity: 'minor', confidence: 'low', evidence: [{ side: 'left', fragmentId: fragment }] }, { headers: idem() });
    expect([404, 409]).toContain(r.status);
  });
});
