// Этап 11: смена ревизии шаблона (D-031 В-11-8) и шаблон заказчика (В-11-9). Черновик остаётся на своей ревизии;
// перенос — явное действие: значения по ключу и типу «перенесено — подтвердите», отчёт показывает изменения подписи,
// единицы, вариантов и применимости, удалённые и новые поля; прежнее приложение «заменено». Ревизия шаблона
// заказчика утверждается руководителем тендера только с основанием; отличия ревизий показываются.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IFormSchema } from '../packages/core/src/index.ts';
import { act, createDraft, createTemplateWithRevision, demoSchema, draftOf, fieldOf, fillAll, KEY_FILLED, setValue, type IDraftView } from './formsFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let templateId = '';
let draft: IDraftView;
const config = testConfig();

const revision2 = (): IFormSchema => {
  const next = demoSchema('demo-key-conditions');
  const field = (sec: string, key: string) => next.sections.find((x) => x.key === sec)!.fields.find((f) => f.key === key)! as unknown as Record<string, unknown>;
  field('general', 'duration_months').label = 'Срок строительства до заключения о соответствии';
  field('payments', 'payment_days').unit = 'кал. дн.';
  (field('general', 'price_kind').options as { value: string; label: string }[]).splice(1, 1);
  field('compensation', 'inflation_threshold').applicableWhen = { field: 'compensation_mechanism', op: 'eq', value: 'inflation' };
  const lists = next.sections.find((x) => x.key === 'lists')!;
  lists.fields = lists.fields.filter((f) => f.key !== 'attention');
  lists.fields.push({ key: 'nominated', type: 'text', label: 'Номинированные поставщики', required: true } as never);
  return next;
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  const t = await createTemplateWithRevision(s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions') });
  templateId = t.templateId;
  draft = await createDraft(s.eng1, s.stageA, t.revisionId, 'Ключевые условия');
  await fillAll(s.eng1, draft.id, { ...KEY_FILLED, price_kind: 'approximate', payment_days: '10', attention: [{ item: 'Класс бетона принят по ведомости заказчика' }] });
});
afterAll(async () => {
  await db.drop();
});

describe('смена ревизии шаблона (D-031 В-11-8)', () => {
  it('новая ревизия: отличия показаны; черновик остаётся на своей ревизии с пометкой о новой', async () => {
    const r = await s.manager.post(`/application-templates/${templateId}/revisions`, { schema: revision2() }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    const view = await s.manager.get(`/template-revisions/${r.body.id}`);
    expect(view.body.diff).toMatchObject({
      added: [expect.objectContaining({ key: 'nominated', required: true })],
      removed: [expect.objectContaining({ key: 'attention' })],
    });
    expect(view.body.diff.changed.map((c: { key: string; changes: { kind: string }[] }) => [c.key, c.changes.map((x) => x.kind)])).toEqual([
      ['price_kind', ['options']],
      ['duration_months', ['label']],
      ['payment_days', ['unit']],
      ['inflation_threshold', ['applicability']],
    ]);
    const a = await s.manager.post(`/template-revisions/${r.body.id}/approve`, {}, { headers: { 'If-Match': r.headers.etag as string } });
    expect(a.status, a.text).toBe(200);
    const d = await draftOf(s.eng1, draft.id);
    expect(d.template).toMatchObject({ revisionId: draft.template.revisionId, newerRevisionAvailable: true, currentRevisionId: r.body.id });
  });

  it('перенос: перенесённые значения требуют подтверждения; отчёт — изменения схемы, несовместимые и новые поля; прежнее «заменено»', async () => {
    const before = await draftOf(s.eng1, draft.id);
    const m = await s.eng1.post(`/application-drafts/${draft.id}/migrate`, {}, { headers: { 'If-Match': before.etag } });
    expect(m.status, m.text).toBe(201);
    const report = m.body.migration as { carried: { key: string; changes: { kind: string }[] }[]; dropped: { key: string; reason: string }[]; added: { key: string }[] };
    expect(Object.fromEntries(report.carried.filter((c) => c.changes.length > 0).map((c) => [c.key, c.changes.map((x) => x.kind)]))).toEqual({
      duration_months: ['label'],
      payment_days: ['unit'],
      inflation_threshold: ['applicability'],
    });
    expect(report.dropped.map((d) => [d.key, d.reason])).toEqual([
      ['price_kind', 'invalid'],
      ['attention', 'removed'],
    ]);
    expect(report.added.map((a) => a.key)).toEqual(['nominated']);
    const next = await draftOf(s.eng1, m.body.id);
    expect(fieldOf(next, 'duration_months').latest).toMatchObject({ state: 'carried_over', origin: 'carried_over', value: '32' });
    const kinds = next.issues.filter((i) => i.blocking).map((i) => i.kind);
    expect(kinds.filter((k) => k === 'carried_over').length).toBe(report.carried.length);
    expect(next.issues.filter((i) => i.kind === 'required_empty').map((i) => i.fieldKey)).toEqual(['price_kind', 'nominated']);
    const old = await draftOf(s.eng1, draft.id);
    expect(old).toMatchObject({ status: 'superseded', supersededByDraftId: m.body.id });
    const write = await act(s.eng1, draft.id, 'payment_days', fieldOf(old, 'payment_days').etag, { action: 'set', value: '11', bases: [] });
    expect(write.status).toBe(409);
    expect(write.body.current.reason).toBe('draft_superseded');
    // Повторное подтверждение перенесённого значения.
    const f = fieldOf(next, 'duration_months');
    const c = await act(s.eng1, next.id, 'duration_months', f.etag, { action: 'confirm' });
    expect(c.status, c.text).toBe(200);
    expect(c.body.field.latest).toMatchObject({ state: 'accepted', value: '32' });
  });
});

describe('шаблон заказчика (D-031 В-11-9)', () => {
  it('ведёт руководитель тендера; ревизия без основания не утверждается; с основанием — утверждается; чужой тендер не видит', async () => {
    expect((await s.eng1.post('/application-templates', { ownerKind: 'customer', tenderId: s.tenderA, name: 'Форма заказчика', isDemo: true }, { headers: idem() })).status).toBe(403);
    const t = await s.manager.post('/application-templates', { ownerKind: 'customer', tenderId: s.tenderA, name: 'Форма заказчика (демо)', isDemo: true }, { headers: idem() });
    expect(t.status, t.text).toBe(201);
    const r = await s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: demoSchema('demo-kp-letter') }, { headers: idem() });
    const noBasis = await s.manager.post(`/template-revisions/${r.body.id}/approve`, {}, { headers: { 'If-Match': r.headers.etag as string } });
    expect(noBasis.status).toBe(409);
    expect(noBasis.body.current.reason).toBe('basis_required');
    const doc = await uploadDocument(db, config, s.eng1, s.stageA, 'Форма КП заказчика.pdf');
    const run = await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Приложение 3. Форма коммерческого предложения участника.'] }] });
    const fr = await fragmentIdOf(db.pool, run, 'Приложение 3. Форма коммерческого предложения участника.');
    await setWorkingSet(s.manager, s.stageA, [doc], true);
    await fixScope(s.manager, s.stageA);
    const ok = await s.manager.post(`/template-revisions/${r.body.id}/approve`, { basisFragmentIds: [fr] }, { headers: { 'If-Match': r.headers.etag as string } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.basis.fragmentIds).toEqual([fr]);
    expect((await s.eng3.get(`/application-templates/${t.body.id}`)).status).toBe(404);
    const list = await s.eng3.get('/application-templates');
    expect(list.body.items.some((x: { id: string }) => x.id === t.body.id)).toBe(false);
    // В черновике структура шаблона заказчика не меняется: поля — только из ревизии.
    const d = await createDraft(s.eng1, s.stageA, r.body.id, 'Форма заказчика');
    const bad = await s.eng1.put(`/application-drafts/${d.id}/fields/extra_field`, { action: 'set', value: 'x', bases: [] }, { headers: { 'If-Match': `"${d.id}:0"` } });
    expect(bad.status).toBe(404);
    await setValue(s.eng1, d.id, 'letter_number', '01/26');
  });
});
