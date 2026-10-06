// Регрессии Review 11-2 (docs/reviews/11-review-2.md). Написаны до исправления продукта; на коде 4604b16 тесты дефектов
// падают, контрольные сценарии (решение по действующему требованию, обсуждение и подтверждение по действующему
// основанию) проходят и до, и после исправления.
// R11-03: решение по требованию без собственных цитат опирается на ревизию требования-предмета — заменённый исходный
// документ требования и изменённое требование не подтверждают значение (API до и после обработки события, вторая линия
// БД, зависимости инвалидации).
// R11-05: скопированное значение (обсуждение, несколько обсуждений подряд, перенос) сохраняет актуальность оснований
// исходной версии — «устарело» видно у текущей версии, «Подтвердить» и «заполнено» по заменённому основанию отвергаются;
// подтверждение по действующему основанию восстанавливает основания значения.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { act, createDraft, createTemplateWithRevision, draftOf, fieldOf, type IDraftView, type IFieldView } from './formsFixtures.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { etagOf } from './mailFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const TZ = 'Фасад облицовывается клинкерным кирпичом по ТЗ.';
const NOTE = 'Кровля выполняется из профнастила С-44 по пояснительной записке.';
const DOCS = ['Условия А.pdf', 'Условия Б.pdf', 'Условия В.pdf', 'Условия Г.pdf', 'Условия Д.pdf'] as const;
const TEXT = (n: number) => `Условие ${n}: оплата выполненных работ в течение 30 рабочих дней.`;

const SCHEMA = {
  schemaVersion: 'forms/1',
  title: 'Регрессии Review 11-2',
  sections: [
    {
      key: 'main',
      title: 'Условия',
      fields: [
        { key: 'condition', type: 'text', label: 'Условие оплаты', multiline: true, required: true },
        { key: 'decision_text', type: 'text', label: 'Условие по решению', multiline: true },
        { key: 'direct_text', type: 'text', label: 'Условие (прямая запись)', multiline: true },
      ],
    },
  ],
};

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let registryId = '';
let templateId = '';
let revisionId = '';
const rev: Record<string, string> = {};
const frag: Record<string, string> = {};
const req = {} as Record<'tz' | 'note', { requirementId: string; revisionId: string }>;
const decision: Record<string, string> = {};
const draft: Record<string, IDraftView> = {};
const config = testConfig();

const processEvents = async () => {
  await worker.maintain({ checkModel: false });
  await drain(worker);
};

const confirmCandidate = async (statement: string, fragmentId: string, extra: Record<string, unknown> = {}) => {
  const c = await s.eng1.post(`/requirement-registries/${registryId}/requirement-candidates`, { statement, evidence: [{ fragmentId, role: 'supports' }], ...extra }, { headers: idem() });
  expect(c.status, c.text).toBe(201);
  const r = await s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(s.manager, `/requirement-candidates/${c.body.id}`), ...idem() } });
  expect(r.status, r.text).toBe(200);
  return { requirementId: r.body.requirementId as string, revisionId: r.body.revisionId as string };
};

// Решение по требованию без собственных цитат (штатный путь API).
const recordDecision = async (requirementId: string, statement: string) => {
  const r = await s.manager.post(`/requirements/${requirementId}/decisions`, { statement, rationale: 'По подтверждённому требованию', evidence: [] }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.decisionId as string;
};

const fieldNow = async (client: TestClient, draftId: string, key: string): Promise<IFieldView> => fieldOf(await draftOf(client, draftId), key);
const put = async (draftId: string, key: string, body: Record<string, unknown>) => act(s.eng1, draftId, key, (await fieldNow(s.eng1, draftId, key)).etag, body);
const versions = async (draftId: string, key: string): Promise<number> =>
  (
    await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id WHERE f.draft_id = $1 AND f.field_key = $2',
      [draftId, key],
    )
  ).rows[0]!.n;
const history = async (draftId: string, key: string) => {
  const r = await s.eng1.get(`/application-drafts/${draftId}/fields/${key}/history`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as { version: number; state: string; stale: boolean; value: unknown; bases: unknown[] }[];
};
const complete = async (draftId: string) => s.eng1.post(`/application-drafts/${draftId}/complete`, {}, { headers: { 'If-Match': (await draftOf(s.eng1, draftId)).etag } });
const replaceDoc = async (name: string) => {
  const id = await uploadDocument(db, config, s.eng1, s.stageA, name);
  expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [id])).rows[0].supersedes_revision_id).toBe(rev[name]);
  return id;
};

// Прямая запись версии ролью kontur_app в обход API.
const direct = async (sql: (c: pg.PoolClient, prev: { id: string; version: number } | undefined) => Promise<void>, fieldId: string): Promise<{ code?: string; message?: string } | null> => {
  const c: pg.PoolClient = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const prev = (await c.query<{ id: string; version: number }>('SELECT id, version FROM draft_field_version WHERE field_id = $1 ORDER BY version DESC LIMIT 1', [fieldId])).rows[0];
    await sql(c, prev);
    await c.query('COMMIT');
    return null;
  } catch (x) {
    await c.query('ROLLBACK').catch(() => undefined);
    return x as { code?: string; message?: string };
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = workerWithChat(db, config, fakeModel(), 'r11b-worker');
  rev.tz = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ.pdf');
  frag.tz = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev.tz, { pages: [{ blocks: [TZ] }] }), TZ);
  rev.note = await uploadDocument(db, config, s.eng1, s.stageA, 'Пояснительная записка.pdf');
  frag.note = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev.note, { pages: [{ blocks: [NOTE] }] }), NOTE);
  for (const [i, name] of DOCS.entries()) {
    rev[name] = await uploadDocument(db, config, s.eng1, s.stageA, name);
    frag[name] = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev[name], { pages: [{ blocks: [TEXT(i + 1)] }] }), TEXT(i + 1));
  }
  await setWorkingSet(s.manager, s.stageA, [rev.tz, rev.note, ...DOCS.map((n) => rev[n]!)], true);
  const scopeId = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр Review 11-2' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  registryId = reg.body.id as string;
  await processEvents();
  req.tz = await confirmCandidate('Фасад — клинкерный кирпич.', frag.tz);
  req.note = await confirmCandidate('Кровля — профнастил С-44.', frag.note);
  decision.tz = await recordDecision(req.tz.requirementId, 'Принять условие о клинкерном фасаде');
  decision.note = await recordDecision(req.note.requirementId, 'Принять условие о кровле');
  const t = await createTemplateWithRevision(s.manager, { name: 'Регрессии Review 11-2', schema: SCHEMA });
  templateId = t.templateId;
  revisionId = t.revisionId;
  for (const k of ['dec', 'a', 'b', 'c', 'd', 'ok']) draft[k] = await createDraft(s.manager, s.stageA, revisionId, `Приложение ${k}`);
});
afterAll(async () => {
  await db.drop();
});

describe('R11-03 — решение по требованию без собственных цитат', () => {
  it('контроль: до замены ТЗ значение по решению записывается, «устарело» нет', async () => {
    const r = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Фасад — клинкер', bases: [{ type: 'decision', id: decision.tz }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ stale: false, bases: [expect.objectContaining({ basisType: 'decision', problem: null })] });
  });

  it('новая редакция ТЗ до обработки события: запись по решению — 409 basis_superseded; прежнее значение «устарело»; прямая запись — 23514', async () => {
    rev.tz2 = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ.pdf');
    const before = await versions(draft.dec!.id, 'decision_text');
    const r = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Фасад — клинкер', bases: [{ type: 'decision', id: decision.tz }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ basisType: 'decision', cause: 'document_revision_superseded' })] });
    expect(await versions(draft.dec!.id, 'decision_text')).toBe(before);
    expect((await fieldNow(s.eng1, draft.dec!.id, 'decision_text')).latest).toMatchObject({ stale: true, bases: [expect.objectContaining({ problem: 'document_revision_superseded' })] });
    const f = await fieldNow(s.eng1, draft.dec!.id, 'direct_text');
    const err = await direct(async (c) => {
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, actor_user_id)
           VALUES ($1, $2, $3, 1, '"в обход API"', 'edited', 'manual', $4) RETURNING id`,
          [f.fieldId, draft.dec!.id, s.tenderA, s.ids.eng1],
        )
      ).rows[0]!.id;
      await c.query("INSERT INTO draft_field_basis (field_version_id, tender_id, basis_type, decision_id) VALUES ($1, $2, 'decision', $3)", [id, s.tenderA, decision.tz]);
    }, f.fieldId);
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*document_revision_superseded/u);
  });

  it('после обработки события — 409; значение по решению получило отметку инвалидации (зависимость от исходного документа)', async () => {
    await processEvents();
    const r = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Фасад — клинкер', bases: [{ type: 'decision', id: decision.tz }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('basis_superseded');
    const latest = (await fieldNow(s.eng1, draft.dec!.id, 'decision_text')).latest!;
    expect(latest.stale).toBe(true);
    expect(latest.invalidations.length).toBeGreaterThan(0);
  });

  it('решение закрепляет ревизию требования: после изменения требования прежнее решение не подтверждает значение, новое решение — подтверждает', async () => {
    const ok = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Кровля — профнастил', bases: [{ type: 'decision', id: decision.note }] });
    expect(ok.status, ok.text).toBe(200);
    const changed = await confirmCandidate('Кровля — профнастил С-44, оцинкованный.', frag.note!, { targetRequirementId: req.note.requirementId });
    expect(changed.requirementId).toBe(req.note.requirementId);
    expect(changed.revisionId).not.toBe(req.note.revisionId);
    const old = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Кровля — профнастил', bases: [{ type: 'decision', id: decision.note }] });
    expect(old.status, old.text).toBe(409);
    expect(old.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ cause: 'requirement_revision_superseded' })] });
    const fresh = await recordDecision(req.note.requirementId, 'Принять изменённое условие о кровле');
    const r = await put(draft.dec!.id, 'decision_text', { action: 'set', value: 'Кровля — профнастил оцинкованный', bases: [{ type: 'decision', id: fresh }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ stale: false });
  });
});

describe('R11-05 — скопированное значение сохраняет актуальность оснований', () => {
  it('обсуждение, затем замена документа: копия «устарела», «Подтвердить» и «заполнено» отвергаются; прямая запись подтверждения — 23514', async () => {
    const d = draft.a!;
    expect((await put(d.id, 'condition', { action: 'set', value: TEXT(1), bases: [{ type: 'fragment', id: frag[DOCS[0]] }] })).status).toBe(200);
    expect((await put(d.id, 'condition', { action: 'discuss', comment: 'Уточнить у заказчика' })).status).toBe(200);
    await replaceDoc(DOCS[0]);
    const f = await fieldNow(s.eng1, d.id, 'condition');
    expect(f.latest).toMatchObject({ state: 'needs_discussion', value: TEXT(1), stale: true });
    expect((await history(d.id, 'condition')).map((v) => [v.state, v.stale])).toEqual([
      ['needs_discussion', true],
      ['edited', true],
    ]);
    const before = await versions(d.id, 'condition');
    const c = await act(s.eng1, d.id, 'condition', f.etag, { action: 'confirm' });
    expect(c.status, c.text).toBe(409);
    expect(c.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ cause: 'document_revision_superseded' })] });
    expect(await versions(d.id, 'condition')).toBe(before);
    const done = await complete(d.id);
    expect(done.status, done.text).toBe(409);
    expect((done.body.current.issues as { kind: string; fieldKey: string }[]).filter((i) => i.fieldKey === 'condition').map((i) => i.kind)).toContain('stale');
    const err = await direct(async (cl, prev) => {
      await cl.query(
        `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, previous_version_id, value_from_version_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, 'accepted', 'manual', $6, $6, $7)`,
        [f.fieldId, d.id, s.tenderA, prev!.version + 1, JSON.stringify(TEXT(1)), prev!.id, s.ids.eng1],
      );
    }, f.fieldId);
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*document_revision_superseded/u);
  });

  it('несколько обсуждений подряд, затем замена документа: «устарело» у последней копии; подтверждение отвергается', async () => {
    const d = draft.b!;
    expect((await put(d.id, 'condition', { action: 'set', value: TEXT(2), bases: [{ type: 'fragment', id: frag[DOCS[1]] }] })).status).toBe(200);
    expect((await put(d.id, 'condition', { action: 'discuss', comment: 'Первое обсуждение' })).status).toBe(200);
    expect((await put(d.id, 'condition', { action: 'discuss', comment: 'Второе обсуждение' })).status).toBe(200);
    await replaceDoc(DOCS[1]);
    await processEvents();
    const f = await fieldNow(s.eng1, d.id, 'condition');
    expect(f.latest).toMatchObject({ value: TEXT(2), stale: true });
    expect((await act(s.eng1, d.id, 'condition', f.etag, { action: 'confirm' })).status).toBe(409);
    expect((await complete(d.id)).status).toBe(409);
  });

  it('замена документа до обсуждения: копия сразу «устарела», подтверждение отвергается', async () => {
    const d = draft.c!;
    expect((await put(d.id, 'condition', { action: 'set', value: TEXT(3), bases: [{ type: 'fragment', id: frag[DOCS[2]] }] })).status).toBe(200);
    await replaceDoc(DOCS[2]);
    expect((await put(d.id, 'condition', { action: 'discuss', comment: 'Документ заменён — обсудить' })).status).toBe(200);
    const f = await fieldNow(s.eng1, d.id, 'condition');
    expect(f.latest).toMatchObject({ state: 'needs_discussion', stale: true });
    const c = await act(s.eng1, d.id, 'condition', f.etag, { action: 'confirm' });
    expect(c.status, c.text).toBe(409);
    expect(c.body.current.reason).toBe('basis_superseded');
  });

  it('перенос значения по заменённому документу: перенесённое значение «устарело», подтверждение и «заполнено» отвергаются', async () => {
    const d = draft.d!;
    expect((await put(d.id, 'condition', { action: 'set', value: TEXT(4), bases: [{ type: 'fragment', id: frag[DOCS[3]] }] })).status).toBe(200);
    await replaceDoc(DOCS[3]);
    const r2 = await s.manager.post(`/application-templates/${templateId}/revisions`, { schema: { ...SCHEMA, title: 'Регрессии Review 11-2, ревизия 2' } }, { headers: idem() });
    expect(r2.status, r2.text).toBe(201);
    expect((await s.manager.post(`/template-revisions/${r2.body.id}/approve`, { basisFragmentIds: [] }, { headers: { 'If-Match': r2.headers.etag as string } })).status).toBe(200);
    const m = await s.eng1.post(`/application-drafts/${d.id}/migrate`, { templateRevisionId: r2.body.id }, { headers: { 'If-Match': (await draftOf(s.eng1, d.id)).etag } });
    expect(m.status, m.text).toBe(201);
    expect(m.body.migration.droppedBases).toEqual([expect.objectContaining({ key: 'condition', cause: 'document_revision_superseded' })]);
    const f = await fieldNow(s.eng1, m.body.id, 'condition');
    expect(f.latest).toMatchObject({ state: 'carried_over', value: TEXT(4), stale: true });
    const c = await act(s.eng1, m.body.id, 'condition', f.etag, { action: 'confirm' });
    expect(c.status, c.text).toBe(409);
    expect(c.body.current.reason).toBe('basis_superseded');
    expect((await complete(m.body.id)).status).toBe(409);
  });

  it('контроль: обсуждение и подтверждение по действующему основанию — основания значения восстановлены, «заполнено» проходит', async () => {
    const d = draft.ok!;
    expect((await put(d.id, 'condition', { action: 'set', value: TEXT(5), bases: [{ type: 'fragment', id: frag[DOCS[4]] }] })).status).toBe(200);
    expect((await put(d.id, 'condition', { action: 'discuss', comment: 'Проверить' })).status).toBe(200);
    const c = await put(d.id, 'condition', { action: 'confirm' });
    expect(c.status, c.text).toBe(200);
    expect(c.body.field.latest).toMatchObject({ state: 'accepted', value: TEXT(5), stale: false });
    const done = await complete(d.id);
    expect(done.status, done.text).toBe(200);
  });

  it('подтверждение копии восстанавливает основания исходной версии', async () => {
    const latest = (await fieldNow(s.eng1, draft.ok!.id, 'condition')).latest!;
    expect(latest.bases).toEqual([expect.objectContaining({ basisType: 'fragment', fragmentId: frag[DOCS[4]] })]);
  });
});
