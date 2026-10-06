// Этап 11 через API (D-031; проект §4): шаблоны и ревизии с правами, приложения этапа, обязательные и условно
// применимые поля, длинная формулировка, несовместимые варианты, два редактора, формулировки библиотеки, обсуждение,
// противоречия между приложениями, история правок, «заполнено». Демонстрационные формы — вымышленный текст.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, createDraft, createTemplateWithRevision, demoSchema, draftOf, fieldOf, fillAll, KEY_FILLED, KP_FILLED, setValue, type IDraftView } from './formsFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db));
});
afterAll(async () => {
  await db.drop();
});

describe('шаблоны и права (D-031 В-11-1…В-11-3)', () => {
  it('шаблон компании ведёт руководитель: инженер получает 403; схема с ошибкой — 400 с перечнем; демо-признак сохраняется', async () => {
    const denied = await s.eng1.post('/application-templates', { ownerKind: 'company', name: 'Ключевые условия', isDemo: true }, { headers: idem() });
    expect(denied.status).toBe(403);
    const t = await s.manager.post('/application-templates', { ownerKind: 'company', name: 'Ключевые условия (демо)', isDemo: true }, { headers: idem() });
    expect(t.status, t.text).toBe(201);
    const bad = await s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: { schemaVersion: 'forms/1', title: 'x', sections: [{ key: 's', title: 'с', fields: [{ key: 'a', type: 'text', label: 'А', applicableWhen: { field: 'zz', op: 'notEmpty' } }] }] } }, { headers: idem() });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.errors)).toContain('неизвестное поле');
    const key = await createTemplateWithRevision(s.manager, { name: 'Ключевые условия ГП (демо)', schema: demoSchema('demo-key-conditions') });
    const kp = await createTemplateWithRevision(s.manager, { name: 'Письмо КП (демо)', schema: demoSchema('demo-kp-letter') });
    Object.assign(ids, { keyTemplate: key.templateId, keyRev: key.revisionId, kpTemplate: kp.templateId, kpRev: kp.revisionId });
    const list = await s.eng1.get('/application-templates');
    expect(list.body.items.find((x: { id: string }) => x.id === key.templateId)).toMatchObject({ isDemo: true, currentRevisionId: key.revisionId, canManage: false });
  });

  it('образец формы — файл ревизии по SHA: загружает тот, кто ведёт шаблон; неизвестный образец — 400', async () => {
    const bytes = Buffer.from('PK демонстрационный образец формы', 'utf8');
    const denied = await s.eng1.post('/form-samples?name=obrazec.docx', bytes, { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
    expect(denied.status).toBe(403);
    const up = await s.manager.post('/form-samples?name=obrazec.docx', bytes, { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
    expect(up.status, up.text).toBe(201);
    expect(up.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const t = await s.manager.post('/application-templates', { ownerKind: 'company', name: 'С образцом', isDemo: true }, { headers: idem() });
    const r = await s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: demoSchema('demo-kp-letter'), sample: { sha256: up.body.sha256, name: 'obrazec.docx' } }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect(r.body.sample).toEqual({ sha256: up.body.sha256, name: 'obrazec.docx' });
    const bad = await s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: demoSchema('demo-kp-letter'), sample: { sha256: 'a'.repeat(64), name: 'x.docx' } }, { headers: idem() });
    expect(bad.status).toBe(400);
  });

  it('черновик ревизии не даёт создать приложение; участник другого тендера приложений этапа не видит', async () => {
    const t = await s.manager.post('/application-templates', { ownerKind: 'company', name: 'Черновик', isDemo: true }, { headers: idem() });
    const r = await s.manager.post(`/application-templates/${t.body.id}/revisions`, { schema: demoSchema('demo-kp-letter') }, { headers: idem() });
    const d = await s.eng1.post(`/stages/${s.stageA}/application-drafts`, { templateRevisionId: r.body.id }, { headers: idem() });
    expect(d.status).toBe(409);
    expect(d.body.current.reason).toBe('revision_not_approved');
    expect((await s.eng3.get(`/stages/${s.stageA}/application-drafts`)).status).toBe(404);
  });
});

describe('заполнение (проверки задания)', () => {
  let ku: IDraftView;
  let kp: IDraftView;

  it('обязательное поле: пустые обязательные — в списке незавершённых, «заполнено» отвергается', async () => {
    ku = await createDraft(s.eng1, s.stageA, ids.keyRev!, 'Ключевые условия');
    kp = await createDraft(s.eng1, s.stageA, ids.kpRev!, 'Письмо КП');
    expect(ku.template.isDemo).toBe(true);
    expect(ku.issues.filter((i) => i.kind === 'required_empty').map((i) => i.fieldKey)).toEqual(['price_kind', 'estimate_units', 'site_upkeep_month', 'duration_months', 'advance_percent', 'compensation_mechanism', 'warranty_months']);
    const c = await s.eng1.post(`/application-drafts/${ku.id}/complete`, {}, { headers: { 'If-Match': ku.etag } });
    expect(c.status).toBe(409);
    expect(c.body.current.reason).toBe('incomplete');
    expect((await s.eng3.get(`/application-drafts/${ku.id}`)).status).toBe(404);
  });

  it('условно применимое поле: порог инфляции требуется только при механизме с инфляцией', async () => {
    await setValue(s.eng1, ku.id, 'compensation_mechanism', 'basket');
    let d = await draftOf(s.eng1, ku.id);
    expect(fieldOf(d, 'inflation_threshold')).toMatchObject({ applicable: false, required: false });
    expect(fieldOf(d, 'basket_corridor')).toMatchObject({ applicable: true, required: true });
    await setValue(s.eng1, ku.id, 'compensation_mechanism', 'inflation');
    d = await draftOf(s.eng1, ku.id);
    expect(fieldOf(d, 'inflation_threshold')).toMatchObject({ applicable: true, required: true });
    expect(d.issues.map((i) => i.fieldKey)).toContain('inflation_threshold');
  });

  it('длинная формулировка: 20 000 символов кириллицы с переносами возвращается без изменений', async () => {
    const long = 'Заказчик настаивает на изменении порядка оплаты; позиция требует согласования в протоколе разногласий.\n'.repeat(200).slice(0, 20000);
    const r = await setValue(s.eng1, ku.id, 'customer_notes', long);
    const sha = (v: unknown) => createHash('sha256').update(String(v), 'utf8').digest('hex');
    expect(sha(r.field.latest!.value)).toBe(sha(long));
    expect(sha(fieldOf(await draftOf(s.eng2, ku.id), 'customer_notes').latest!.value)).toBe(sha(long));
  });

  it('несовместимые варианты: методика не соответствует механизму компенсации — пункт незавершённого', async () => {
    await fillAll(s.eng1, ku.id, { ...KEY_FILLED, methodology_variant: 'basket_only' });
    const d = await draftOf(s.eng1, ku.id);
    expect(d.issues.filter((i) => i.blocking).map((i) => [i.kind, i.label])).toEqual([['constraint', 'methodology_matches_mechanism']]);
    await setValue(s.eng1, ku.id, 'methodology_variant', 'inflation_only');
    expect((await draftOf(s.eng1, ku.id)).blocking).toBe(0);
  });

  it('два редактора: запись по прежней версии поля — 412, значение первого не перезаписано', async () => {
    const f = fieldOf(await draftOf(s.eng1, ku.id), 'payment_days');
    const a = await act(s.eng1, ku.id, 'payment_days', f.etag, { action: 'set', value: '10', bases: [] });
    const b = await act(s.eng2, ku.id, 'payment_days', f.etag, { action: 'set', value: '15', bases: [] });
    expect([a.status, b.status]).toEqual([200, 412]);
    expect(fieldOf(await draftOf(s.eng1, ku.id), 'payment_days').latest).toMatchObject({ value: '10', version: 1 });
  });

  it('противоречие между приложениями: аванс 30 % и 20 % — у обоих; позиция заказчика — другой предмет; исправление снимает', async () => {
    await fillAll(s.eng1, kp.id, { ...KP_FILLED, advance_percent: '20' });
    await setValue(s.eng1, ku.id, 'customer_advance_percent', '10');
    const a = await draftOf(s.eng1, ku.id);
    const b = await draftOf(s.eng1, kp.id);
    expect(a.issues.filter((i) => i.kind === 'contradiction').map((i) => i.fieldKey)).toEqual(['advance_percent']);
    expect(b.issues.filter((i) => i.kind === 'contradiction').map((i) => i.message)).toEqual(['противоречие — «Общий аванс» в приложении «Ключевые условия»: значения различаются']);
    const c = await s.eng1.post(`/application-drafts/${kp.id}/complete`, {}, { headers: { 'If-Match': b.etag } });
    expect(c.status).toBe(409);
    await setValue(s.eng1, kp.id, 'advance_percent', '30.00');
    expect((await draftOf(s.eng1, kp.id)).issues.filter((i) => i.kind === 'contradiction')).toEqual([]);
    // Неизвестное — не совпадение: гарантийный срок не заполнен в письме — «не сверено», не блокирует.
    expect((await draftOf(s.eng1, ku.id)).issues.filter((i) => i.kind === 'unverified').map((i) => [i.fieldKey, i.blocking])).toContainEqual(['warranty_months', false]);
  });

  it('формулировки: инженер предлагает, руководитель утверждает; выбор формулировки закрепляет версию; новая версия — пометка, не «устарело»', async () => {
    const p = await s.eng1.post('/approved-wordings', { title: 'Сметы по этажам', text: 'Сметы составляются с единицей измерения «этаж», «секция» или комплексом работ.', tags: ['сметы'] }, { headers: idem() });
    expect(p.status, p.text).toBe(201);
    expect((await s.eng1.post(`/wording-versions/${p.body.versionId}/decision`, { status: 'approved' }, { headers: { 'If-Match': p.body.etag } })).status).toBe(403);
    const ok = await s.manager.post(`/wording-versions/${p.body.versionId}/decision`, { status: 'approved' }, { headers: { 'If-Match': p.body.etag } });
    expect(ok.status, ok.text).toBe(200);
    const f = fieldOf(await draftOf(s.eng1, ku.id), 'estimate_units');
    const r = await act(s.eng1, ku.id, 'estimate_units', f.etag, { action: 'choose_wording', wordingVersionId: p.body.versionId });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ origin: 'approved_wording', state: 'accepted', value: 'Сметы составляются с единицей измерения «этаж», «секция» или комплексом работ.' });
    const v2 = await s.eng1.post(`/approved-wordings/${p.body.wordingId}/versions`, { text: 'Сметы составляются по этажам и секциям.', tags: ['сметы'] }, { headers: idem() });
    await s.manager.post(`/wording-versions/${v2.body.versionId}/decision`, { status: 'approved' }, { headers: { 'If-Match': v2.body.etag } });
    const after = fieldOf(await draftOf(s.eng1, ku.id), 'estimate_units').latest!;
    expect(after).toMatchObject({ stale: false, wording: expect.objectContaining({ newerApproved: true }) });
  });

  it('«обсудить»: комментарий, ответственный и вопрос заказчику; значение сохраняется; блокирует «заполнено»', async () => {
    const f = fieldOf(await draftOf(s.eng1, ku.id), 'site_upkeep_month');
    const r = await act(s.eng1, ku.id, 'site_upkeep_month', f.etag, { action: 'discuss', comment: 'Уточнить сумму у заказчика', responsibleUserId: s.ids.eng2, createQuestion: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ state: 'needs_discussion', value: '25', comment: 'Уточнить сумму у заказчика', customerQuestionId: expect.any(String) });
    const q = await db.pool.query('SELECT status, text FROM customer_question WHERE id = $1', [r.body.field.latest.customerQuestionId]);
    expect(q.rows[0]).toEqual({ status: 'draft', text: 'Компенсация содержания площадки за дополнительный месяц: Уточнить сумму у заказчика' });
    expect(r.body.draft.issues.find((i: { kind: string }) => i.kind === 'needs_discussion').message).toBe('требует обсуждения (ответственный — Инженер 2): Уточнить сумму у заказчика');
  });

  it('история правок и «заполнено»: подтверждение после обсуждения; «заполнено»; новая правка возвращает в работу', async () => {
    const f = fieldOf(await draftOf(s.eng1, ku.id), 'site_upkeep_month');
    expect((await act(s.eng2, ku.id, 'site_upkeep_month', f.etag, { action: 'confirm' })).status).toBe(200);
    const h = await s.eng1.get(`/application-drafts/${ku.id}/fields/site_upkeep_month/history`);
    expect(h.body.items.map((v: { version: number; state: string; actor: { name: string } }) => [v.version, v.state, v.actor.name])).toEqual([
      [3, 'accepted', 'Инженер 2'],
      [2, 'needs_discussion', 'Инженер 1'],
      [1, 'edited', 'Инженер 1'],
    ]);
    const d = await draftOf(s.eng1, ku.id);
    expect(d.issues.filter((i) => i.blocking)).toEqual([]);
    const c = await s.eng1.post(`/application-drafts/${ku.id}/complete`, {}, { headers: { 'If-Match': d.etag } });
    expect(c.status, c.text).toBe(200);
    expect(c.body.status).toBe('complete');
    await setValue(s.eng1, ku.id, 'payment_days', '12');
    expect((await draftOf(s.eng1, ku.id)).status).toBe('in_progress');
  });

  it('событие барьера: каждая новая версия поля — draft_field_changed (класс content), проверки не гасит', async () => {
    const ev = await db.pool.query("SELECT count(*)::int AS n, min(event_class) AS c FROM stage_input_event WHERE stage_id = $1 AND event_type = 'draft_field_changed'", [s.stageA]);
    expect(ev.rows[0].n).toBeGreaterThan(20);
    expect(ev.rows[0].c).toBe('content');
  });
});
