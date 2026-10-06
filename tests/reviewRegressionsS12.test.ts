// Регрессии дефектов, найденных разработчиком в этапе 12. S12-01 (D-032 В-12-9): свежесть прогона проверок считала
// правку поля приложения (draft_field_changed, класс content) «новым источником»; отрицательная — правка поля прогон не
// делает устаревшим, положительная — новая редакция документа делает (инвалидация по реальным зависимостям сохранена).
// S12-02: конфликт команды над шаблоном компании (цель без тендера) записывался в журнал с пустым UUID — 500 вместо 409.
// На коде до исправления отрицательная S12-01 и S12-02 падают, положительная S12-01 проходит.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDraft, createTemplateWithRevision, demoSchema, setValue } from './formsFixtures.ts';
import { auditRows, createTestDb, drain, testConfig, type ITestDb } from './helpers.ts';
import { buildStage09, closeHub, runReview, type IRunView, type IStage09 } from './reviewFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage09;
let run: IRunView;

const freshness = async () => {
  const r = await st.s.eng1.get(`/review-runs/${run.id}`);
  expect(r.status, r.text).toBe(200);
  return r.body.freshness as { outdated: boolean; reasons: string[]; events: { type: string }[] };
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  run = await runReview(st);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('S12-01 — свежесть прогона проверок и события барьера', () => {
  it('отрицательная: правка поля приложения этапа не делает прогон устаревшим', async () => {
    expect((await freshness()).outdated).toBe(false);
    const t = await createTemplateWithRevision(st.s.manager, { name: 'Письмо КП (демо)', schema: demoSchema('demo-kp-letter') });
    const d = await createDraft(st.s.eng1, st.s.stageA, t.revisionId, 'Письмо КП');
    await setValue(st.s.eng1, d.id, 'letter_number', '04/26-01-ТО');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM stage_input_event WHERE stage_id = $1 AND event_type = 'draft_field_changed'", [st.s.stageA])).rows[0].n).toBeGreaterThan(0);
    await st.worker.maintain({ checkModel: false });
    await drain(st.worker);
    const f = await freshness();
    expect(f.outdated, f.reasons.join('; ')).toBe(false);
  });

  it('положительная: новая редакция документа — прогон устарел, «поступили источники»', async () => {
    await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ТЗ.pdf');
    const f = await freshness();
    expect(f.outdated).toBe(true);
    expect(f.reasons.join(' ')).toMatch(/поступили источники/u);
  });
});

describe('S12-02 — конфликт команды над шаблоном компании', () => {
  it('повторное утверждение ревизии шаблона компании — 409 revision_not_draft, отказ в журнале без тендера', async () => {
    const t = await createTemplateWithRevision(st.s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions') });
    const r = await st.s.manager.get(`/template-revisions/${t.revisionId}`);
    expect(r.body.status).toBe('approved');
    const again = await st.s.manager.post(`/template-revisions/${t.revisionId}/approve`, { basisFragmentIds: [] }, { headers: { 'If-Match': r.body.etag as string } });
    expect(again.status, again.text).toBe(409);
    expect(again.body.current.reason).toBe('revision_not_draft');
    const rows = await auditRows(db.pool, "action = 'forms.template_revision.approve' AND outcome = 'failed' AND entity_id = $1", [t.revisionId]);
    expect(rows.map((x) => x.tender_id ?? null)).toEqual([null]);
  });
});
