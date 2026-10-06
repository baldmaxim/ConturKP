// Регрессии Review 11-1 (docs/reviews/11-review-1.md). Написаны до исправления продукта; на коде bf4d44f тесты дефектов
// падают, контрольные сценарии (прямое закрытое основание, действующее основание до новой редакции ТЗ) проходят и до,
// и после исправления.
// R11-01: косвенное основание (ревизия требования, решение) наследует права источника — значение, история и команды.
// R11-02: «обсудить» не копирует и не раскрывает скрытое значение; ограничение сохраняется при отзыве права и переносе.
// R11-03: заменённый исходный документ требования, решения и факта не подтверждает значение — API до и после обработки
// событий и вторая линия БД.
// R11-04: системное предложение суммы сохраняет единицу, масштаб и валюту источника; неизвестное — «не сверено».
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { checkConsistency, gateSuggestion, valueFromFactText, type IField, type IFieldObservation } from '../packages/core/src/index.ts';
import { act, createDraft, createTemplateWithRevision, draftOf, fieldOf, type IDraftView } from './formsFixtures.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { createMailbox, eml, etagOf, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';
import { buildIndex, fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const SECRET_LETTER = 'Закрытое условие письма: аванс сорок процентов после подписания.';
const SECRET_REQ = 'Секретное условие по письму заказчика: аванс сорок процентов.';
const TZ = 'Кровля выполняется из профнастила С-44 по ТЗ.';
const PRICE = 'Цена договора составляет 25 000 000 руб.';
const WARRANTY = 'Гарантийный срок составляет 36 месяцев.';
const MAIL_ACCESS = ['mail.read', 'mail.import', 'mail.link'];

const SCHEMA = {
  schemaVersion: 'forms/1',
  title: 'Регрессии Review 11-1',
  sections: [
    {
      key: 'conditions',
      title: 'Условия',
      fields: [
        { key: 'mail_text', type: 'text', label: 'Условие по письму', multiline: true },
        { key: 'req_text', type: 'text', label: 'Условие по требованию', multiline: true },
        { key: 'decision_text', type: 'text', label: 'Условие по решению', multiline: true },
        { key: 'tz_text', type: 'text', label: 'Условие по ТЗ', multiline: true },
        { key: 'tz_direct', type: 'text', label: 'Условие по ТЗ (прямая запись)', multiline: true },
        { key: 'price_mln', type: 'number', label: 'Цена, млн руб.', unit: 'млн руб.', currency: 'RUB', scale: 6, meaning: 'fact:contract_price' },
        { key: 'price_rub', type: 'number', label: 'Цена, руб.', unit: 'руб.', currency: 'RUB', scale: 2, meaning: 'fact:contract_price' },
        { key: 'price_usd', type: 'number', label: 'Цена, USD', unit: 'USD', currency: 'USD', scale: 2, meaning: 'fact:contract_price' },
        { key: 'warranty', type: 'number', label: 'Гарантийный срок', unit: 'мес.', meaning: 'fact:warranty_period' },
      ],
    },
  ],
};

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let box = '';
let registryId = '';
let templateId = '';
let draftA: IDraftView;
let draftB: IDraftView;
const frag: Record<string, string> = {};
const rev: Record<string, string> = {};
const req = {} as Record<'mail' | 'tz', { requirementId: string; revisionId: string }>;
const decision: Record<string, string> = {};
const config = testConfig();

const processEvents = async () => {
  await worker.maintain({ checkModel: false });
  await drain(worker);
};

const confirmedRequirement = async (statement: string, fragmentId: string) => {
  const c = await s.eng1.post(`/requirement-registries/${registryId}/requirement-candidates`, { statement, evidence: [{ fragmentId, role: 'supports' }] }, { headers: idem() });
  expect(c.status, c.text).toBe(201);
  const r = await s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(s.manager, `/requirement-candidates/${c.body.id}`), ...idem() } });
  expect(r.status, r.text).toBe(200);
  return { requirementId: r.body.requirementId as string, revisionId: r.body.revisionId as string };
};

const recordDecision = async (requirementId: string, statement: string, evidence: { fragmentId: string; role: string }[]) => {
  const r = await s.manager.post(`/requirements/${requirementId}/decisions`, { statement, rationale: 'решение руководителя', evidence }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.decisionId as string;
};

const fieldNow = async (client: TestClient, draftId: string, key: string) => fieldOf(await draftOf(client, draftId), key);
const put = async (client: TestClient, draftId: string, key: string, body: Record<string, unknown>) => act(client, draftId, key, (await fieldNow(s.manager, draftId, key)).etag, body);
const versions = async (draftId: string, key: string): Promise<number> =>
  (
    await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id WHERE f.draft_id = $1 AND f.field_key = $2',
      [draftId, key],
    )
  ).rows[0]!.n;
const history = async (client: TestClient, draftId: string, key: string) => {
  const r = await client.get(`/application-drafts/${draftId}/fields/${key}/history`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as { value: unknown; restricted: boolean; state: string; comment: string | null }[];
};

// Прямая запись версии поля ролью kontur_app в обход API: возвращает ошибку или null.
const directWrite = async (draft: IDraftView, key: string, basis: { column: string; type: string; id: string }): Promise<{ code?: string; message?: string } | null> => {
  const f = await fieldNow(s.manager, draft.id, key);
  const c: pg.PoolClient = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const prev = (await c.query<{ id: string; version: number }>('SELECT id, version FROM draft_field_version WHERE field_id = $1 ORDER BY version DESC LIMIT 1', [f.fieldId])).rows[0];
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, previous_version_id, actor_user_id)
         VALUES ($1, $2, $3, $4, '"в обход API"', 'edited', 'manual', $5, $6) RETURNING id`,
        [f.fieldId, draft.id, s.tenderA, (prev?.version ?? 0) + 1, prev?.id ?? null, s.ids.eng1],
      )
    ).rows[0]!.id;
    await c.query(`INSERT INTO draft_field_basis (field_version_id, tender_id, basis_type, ${basis.column}) VALUES ($1, $2, $3, $4)`, [id, s.tenderA, basis.type, basis.id]);
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
  worker = workerWithChat(db, config, fakeModel(), 'r11-worker');
  // Закрытый ящик: письмо читают руководитель и (до отзыва) инженер 1.
  box = await createMailbox(s.admin, 'forms-r11@contractor.example.test', 'Ящик Review 11-1');
  for (const id of [s.ids.eng1, s.ids.manager]) await setMailAccess(s.admin, box, id, MAIL_ACCESS);
  const letter = await importEml(s.eng1, worker, box, eml({ messageId: 'forms-r11@example.test', subject: 'Аванс', text: SECRET_LETTER }));
  await linkMail(s.eng1, letter.messageId!, s.tenderA, s.stageA);
  frag.letter = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [letter.revisionId])).rows[0]!.id;
  rev.tz = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ.pdf');
  frag.tz = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev.tz, { pages: [{ blocks: [TZ] }] }), TZ);
  rev.contract = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор генподряда.pdf');
  const contractRun = await seedEvidenceRun(db.pool, rev.contract, { pages: [{ blocks: ['Договор генподряда № Г-1 от 01.02.2026', PRICE, WARRANTY] }] });
  frag.price = await fragmentIdOf(db.pool, contractRun, PRICE);
  await setWorkingSet(s.manager, s.stageA, [rev.tz, rev.contract], true);
  const scopeId = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр Review 11-1' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  registryId = reg.body.id as string;
  await buildIndex(db, worker);
  await worker.scheduleFactExtraction();
  await processEvents();
  req.mail = await confirmedRequirement(SECRET_REQ, frag.letter);
  req.tz = await confirmedRequirement('Кровля — профнастил С-44 по ТЗ.', frag.tz);
  decision.mail = await recordDecision(req.mail.requirementId, 'Принять секретное условие письма.', []);
  decision.tz = await recordDecision(req.tz.requirementId, 'Кровля по ТЗ принята.', [{ fragmentId: frag.tz, role: 'supports' }]);
  // Инженер 1 теряет доступ к ящику: письмо, требование и решение по нему для него закрыты.
  await setMailAccess(s.admin, box, s.ids.eng1, []);
  const t = await createTemplateWithRevision(s.manager, { name: 'Регрессии Review 11-1', schema: SCHEMA });
  templateId = t.templateId;
  draftA = await createDraft(s.manager, s.stageA, t.revisionId, 'Закрытые основания');
  draftB = await createDraft(s.manager, s.stageA, t.revisionId, 'Суммы и актуальность');
});
afterAll(async () => {
  await db.drop();
});

describe('R11-01 — косвенное основание наследует права источника', () => {
  it('контроль: прямое закрытое основание скрывает значение и запрещает запись без mail.read', async () => {
    const own = await put(s.manager, draftA.id, 'mail_text', { action: 'set', value: SECRET_LETTER, bases: [{ type: 'fragment', id: frag.letter }] });
    expect(own.status, own.text).toBe(200);
    const f = await fieldNow(s.eng1, draftA.id, 'mail_text');
    expect(f.latest).toMatchObject({ restricted: true, value: null });
    const denied = await act(s.eng1, draftA.id, 'mail_text', f.etag, { action: 'set', value: 'другое', bases: [{ type: 'fragment', id: frag.letter }] });
    expect(denied.status).toBe(409);
    expect(denied.body.current.reason).toBe('restricted_fragments');
  });

  it('значение по ревизии требования из закрытого письма скрыто в приложении и истории, как само требование', async () => {
    const card = await s.eng1.get(`/requirements/${req.mail.requirementId}`);
    expect(card.status, card.text).toBe(200);
    expect(card.body).toMatchObject({ restricted: true, statement: null });
    const set = await put(s.manager, draftA.id, 'req_text', { action: 'set', value: SECRET_REQ, bases: [{ type: 'requirement_revision', id: req.mail.revisionId }] });
    expect(set.status, set.text).toBe(200);
    const view = await s.eng1.get(`/application-drafts/${draftA.id}`);
    expect(view.status, view.text).toBe(200);
    expect(fieldOf(view.body as IDraftView, 'req_text').latest).toMatchObject({ restricted: true, value: null });
    expect(view.text).not.toContain(SECRET_REQ);
    const h = await s.eng1.get(`/application-drafts/${draftA.id}/fields/req_text/history`);
    expect(h.status, h.text).toBe(200);
    expect(h.text).not.toContain(SECRET_REQ);
    expect((h.body.items as { restricted: boolean }[]).every((v) => v.restricted)).toBe(true);
  });

  it('подтверждение такого значения инженером без доступа отвергается без раскрытия текста; версия не создаётся', async () => {
    const before = await versions(draftA.id, 'req_text');
    const f = await fieldNow(s.eng1, draftA.id, 'req_text');
    const r = await act(s.eng1, draftA.id, 'req_text', f.etag, { action: 'confirm' });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('restricted_fragments');
    expect(r.text).not.toContain(SECRET_REQ);
    expect(await versions(draftA.id, 'req_text')).toBe(before);
  });

  it('новая запись по невидимой ревизии требования отвергается', async () => {
    const r = await act(s.eng1, draftA.id, 'req_text', (await fieldNow(s.eng1, draftA.id, 'req_text')).etag, {
      action: 'set',
      value: 'ссылка на чужое',
      bases: [{ type: 'requirement_revision', id: req.mail.revisionId }],
    });
    expect(r.status).toBe(409);
    expect(r.body.current.reason).toBe('restricted_fragments');
  });

  it('решение по закрытому требованию наследует закрытость: значение скрыто, подтверждение отвергается', async () => {
    const set = await put(s.manager, draftA.id, 'decision_text', { action: 'set', value: SECRET_REQ, bases: [{ type: 'decision', id: decision.mail }] });
    expect(set.status, set.text).toBe(200);
    const f = await fieldNow(s.eng1, draftA.id, 'decision_text');
    expect(f.latest).toMatchObject({ restricted: true, value: null });
    expect((await history(s.eng1, draftA.id, 'decision_text')).every((v) => v.restricted && v.value === null)).toBe(true);
    const r = await act(s.eng1, draftA.id, 'decision_text', f.etag, { action: 'confirm' });
    expect(r.status).toBe(409);
    expect(r.text).not.toContain(SECRET_REQ);
  });

  it('руководитель с доступом видит значение по требованию и решению; попытки инженера его не изменили', async () => {
    expect((await fieldNow(s.manager, draftA.id, 'req_text')).latest).toMatchObject({ restricted: false, value: SECRET_REQ });
    expect((await fieldNow(s.manager, draftA.id, 'decision_text')).latest).toMatchObject({ restricted: false, value: SECRET_REQ });
  });
});

describe('R11-02 — «обсудить» не раскрывает скрытое значение', () => {
  it('инженер без доступа: «обсудить» отвергается, текст не копируется и не возвращается', async () => {
    const before = await versions(draftA.id, 'mail_text');
    const f = await fieldNow(s.eng1, draftA.id, 'mail_text');
    expect(f.latest).toMatchObject({ restricted: true, value: null });
    const r = await act(s.eng1, draftA.id, 'mail_text', f.etag, { action: 'discuss', comment: 'Прошу обсудить условие', responsibleUserId: s.ids.eng1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('restricted_fragments');
    expect(r.text).not.toContain(SECRET_LETTER);
    expect(await versions(draftA.id, 'mail_text')).toBe(before);
    expect((await history(s.eng1, draftA.id, 'mail_text')).every((v) => v.restricted && v.value === null)).toBe(true);
  });

  it('обсуждение руководителем сохраняет ограничение: для инженера версия, комментарий и пункт списка скрыты', async () => {
    const r = await put(s.manager, draftA.id, 'mail_text', { action: 'discuss', comment: 'Комментарий руководителя по письму', responsibleUserId: s.ids.manager });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ state: 'needs_discussion', value: SECRET_LETTER, restricted: false });
    const view = await s.eng1.get(`/application-drafts/${draftA.id}`);
    expect(fieldOf(view.body as IDraftView, 'mail_text').latest).toMatchObject({ state: 'needs_discussion', restricted: true, value: null, comment: null });
    expect(view.text).not.toContain(SECRET_LETTER);
    expect(view.text).not.toContain('Комментарий руководителя по письму');
    expect((view.body as IDraftView).issues.find((i) => i.fieldKey === 'mail_text' && i.kind === 'needs_discussion')).toBeTruthy();
    const h = await s.eng1.get(`/application-drafts/${draftA.id}/fields/mail_text/history`);
    expect(h.text).not.toContain(SECRET_LETTER);
    expect((h.body.items as { restricted: boolean }[]).every((v) => v.restricted)).toBe(true);
    const issues = await s.eng1.get(`/stages/${s.stageA}/application-issues`);
    expect(issues.status, issues.text).toBe(200);
    expect(issues.text).not.toContain('Комментарий руководителя по письму');
  });

  it('отзыв права после создания версии: обсуждение скрыто и от самого автора', async () => {
    await setMailAccess(s.admin, box, s.ids.manager, []);
    try {
      expect((await fieldNow(s.manager, draftA.id, 'mail_text')).latest).toMatchObject({ restricted: true, value: null });
      expect((await history(s.manager, draftA.id, 'mail_text')).every((v) => v.restricted && v.value === null)).toBe(true);
      const f = await fieldNow(s.manager, draftA.id, 'mail_text');
      const r = await act(s.manager, draftA.id, 'mail_text', f.etag, { action: 'confirm' });
      expect(r.status).toBe(409);
      expect(r.text).not.toContain(SECRET_LETTER);
    } finally {
      await setMailAccess(s.admin, box, s.ids.manager, MAIL_ACCESS);
    }
  });

  it('перенос на новую ревизию: перенесённые значения сохраняют ограничения исходных версий', async () => {
    const r2 = await s.manager.post(`/application-templates/${templateId}/revisions`, { schema: { ...SCHEMA, title: 'Регрессии Review 11-1, ревизия 2' } }, { headers: idem() });
    expect(r2.status, r2.text).toBe(201);
    const ok = await s.manager.post(`/template-revisions/${r2.body.id}/approve`, { basisFragmentIds: [] }, { headers: { 'If-Match': r2.headers.etag as string } });
    expect(ok.status, ok.text).toBe(200);
    const d = await draftOf(s.manager, draftA.id);
    const m = await s.manager.post(`/application-drafts/${draftA.id}/migrate`, { templateRevisionId: r2.body.id }, { headers: { 'If-Match': d.etag } });
    expect(m.status, m.text).toBe(201);
    const view = await s.eng1.get(`/application-drafts/${m.body.id}`);
    expect(view.status, view.text).toBe(200);
    for (const key of ['mail_text', 'req_text', 'decision_text']) expect(fieldOf(view.body as IDraftView, key).latest, key).toMatchObject({ state: 'carried_over', restricted: true, value: null });
    expect(view.text).not.toContain(SECRET_LETTER);
    expect(view.text).not.toContain(SECRET_REQ);
    expect(fieldOf(await draftOf(s.manager, m.body.id), 'mail_text').latest).toMatchObject({ restricted: false, value: SECRET_LETTER });
  });
});

describe('R11-04 — сумма из факта сохраняет единицу, масштаб и валюту', () => {
  const money = (unit: string, currency: string): IField => ({ key: 'price', type: 'number', label: 'Цена', unit, currency, scale: 6 }) as IField;

  it('ядро: точный перевод масштаба; другая валюта и неизвестный контекст — без предложения', () => {
    expect(valueFromFactText(money('млн руб.', 'RUB'), '25 000 000 руб.')).toBe('25');
    expect(valueFromFactText(money('руб.', 'RUB'), '25 млн руб.')).toBe('25000000');
    expect(valueFromFactText(money('USD', 'USD'), '100 руб.')).toBeNull();
    // Фраза факта без валюты: контекст неизвестен — валюта поля не приписывается.
    expect(valueFromFactText(money('млн руб.', 'RUB'), 'Цена договора составляет 25 000 000')).toBeNull();
    expect(valueFromFactText(money('млн руб.', 'RUB'), 'Цена договора составляет 25 000 000', 'Цена договора составляет 25 000 000 руб.')).toBe('25');
    expect(valueFromFactText(money('руб.', 'RUB'), 'Цена договора составляет 25', 'Цена договора составляет 25 млн руб.')).toBe('25000000');
  });

  it('ядро: гейт модели и сверка с фактом учитывают валюту и масштаб', () => {
    const input = { fieldKey: 'price', label: 'Цена', type: 'number' as const, help: null, unit: 'USD', options: null, fragments: [{ label: 'E1', fragmentId: '00000000-0000-4000-8000-000000000001', origin: 'document_text', text: PRICE }] };
    const usd = gateSuggestion(money('USD', 'USD'), input, { value: '25000000', rationale: '', citations: [{ evidence: 'E1', quote: PRICE }] });
    expect(usd.passed).toBe(false);
    const mln = gateSuggestion(money('млн руб.', 'RUB'), { ...input, unit: 'млн руб.' }, { value: '25000000', rationale: '', citations: [{ evidence: 'E1', quote: PRICE }] });
    expect(mln.passed).toBe(false);
    const ok = gateSuggestion(money('млн руб.', 'RUB'), { ...input, unit: 'млн руб.' }, { value: '25', rationale: '', citations: [{ evidence: 'E1', quote: PRICE }] });
    expect(ok.passed, JSON.stringify(ok.issues)).toBe(true);
    const obs = (unit: string, currency: string, value: string): IFieldObservation => ({
      draftId: 'd',
      draftTitle: 'Приложение',
      fieldKey: `price_${currency}_${unit}`,
      label: 'Цена',
      type: 'number',
      unit,
      groupKeys: ['fact:contract_price'],
      context: { subject: '', period: '', unit: unit.toLowerCase(), currency },
      value,
    });
    const ref = { groupKey: 'fact:contract_price', kind: 'fact' as const, id: 'f', title: 'Цена договора', text: 'Цена договора составляет 25 000 000', context: PRICE, status: 'active' as const };
    expect(checkConsistency([obs('USD', 'USD', '25000000')], [ref]).map((x) => x.kind)).toEqual(['unverified']);
    expect(checkConsistency([obs('млн руб.', 'RUB', '25')], [ref])).toEqual([]);
    expect(checkConsistency([obs('руб.', 'RUB', '25')], [ref]).map((x) => x.kind)).toEqual(['contradiction']);
    expect(checkConsistency([obs('млн руб.', 'RUB', '25')], [{ ...ref, context: null }]).map((x) => x.kind)).toEqual(['unverified']);
  });

  it('API: предложения из факта «25 000 000 руб.» — 25 для «млн руб.», 25000000 для «руб.», для USD предложения нет', async () => {
    const d = await draftOf(s.eng1, draftB.id);
    expect(fieldOf(d, 'price_mln').systemProposals.map((p) => p.value)).toEqual(['25']);
    expect(fieldOf(d, 'price_rub').systemProposals.map((p) => p.value)).toEqual(['25000000']);
    expect(fieldOf(d, 'price_usd').systemProposals).toEqual([]);
  });

  it('API: принять факт в поле USD нельзя; в поле «млн руб.» принимается 25', async () => {
    const factId = fieldOf(await draftOf(s.eng1, draftB.id), 'price_mln').systemProposals[0]!.evidenceFactId;
    const before = await versions(draftB.id, 'price_usd');
    const usd = await act(s.eng1, draftB.id, 'price_usd', (await fieldNow(s.eng1, draftB.id, 'price_usd')).etag, { action: 'accept_fact', evidenceFactId: factId });
    expect(usd.status, usd.text).toBe(409);
    expect(usd.body.current.reason).toBe('fact_value_unavailable');
    expect(await versions(draftB.id, 'price_usd')).toBe(before);
    const mln = await act(s.eng1, draftB.id, 'price_mln', (await fieldNow(s.eng1, draftB.id, 'price_mln')).etag, { action: 'accept_fact', evidenceFactId: factId });
    expect(mln.status, mln.text).toBe(200);
    expect(mln.body.field.latest).toMatchObject({ value: '25', origin: 'system_suggestion' });
  });

  it('API: сверка — USD-значение «не сверено», а не совпадение; 25 в поле «руб.» — противоречие', async () => {
    expect((await put(s.eng1, draftB.id, 'price_usd', { action: 'set', value: '25000000', bases: [] })).status).toBe(200);
    expect((await put(s.eng1, draftB.id, 'price_rub', { action: 'set', value: '25', bases: [] })).status).toBe(200);
    const d = await draftOf(s.eng1, draftB.id);
    // Только сверка с фактом (сравнения с пустыми полями других приложений — отдельные пункты «не сверено»).
    const kinds = (key: string) => d.issues.filter((i) => i.fieldKey === key && i.message.includes('факт «Цена договора»')).map((i) => i.kind);
    expect(kinds('price_usd')).toEqual(['unverified']);
    expect(kinds('price_rub')).toEqual(['contradiction']);
    expect(kinds('price_mln')).toEqual([]);
  });
});

describe('R11-03 — заменённый исходный документ требования, решения и факта не подтверждает значение', () => {
  it('контроль: до новой редакции ТЗ значение по требованию и решению записывается', async () => {
    const r = await put(s.eng1, draftB.id, 'tz_text', { action: 'set', value: 'Кровля — профнастил С-44', bases: [{ type: 'requirement_revision', id: req.tz.revisionId }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ stale: false });
  });

  it('новая редакция ТЗ до обработки события: запись по ревизии требования и по решению — 409 basis_superseded', async () => {
    rev.tz2 = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ.pdf');
    expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [rev.tz2])).rows[0].supersedes_revision_id).toBe(rev.tz);
    const before = await versions(draftB.id, 'tz_text');
    const r = await put(s.eng1, draftB.id, 'tz_text', { action: 'set', value: 'Кровля — профнастил С-44', bases: [{ type: 'requirement_revision', id: req.tz.revisionId }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ cause: 'document_revision_superseded' })] });
    const d = await put(s.eng1, draftB.id, 'tz_text', { action: 'set', value: 'Кровля — профнастил С-44', bases: [{ type: 'decision', id: decision.tz }] });
    expect(d.status, d.text).toBe(409);
    expect(d.body.current.reason).toBe('basis_superseded');
    expect(await versions(draftB.id, 'tz_text')).toBe(before);
    const f = await fieldNow(s.eng1, draftB.id, 'tz_text');
    expect(f.latest).toMatchObject({ stale: true });
    expect((await act(s.eng1, draftB.id, 'tz_text', f.etag, { action: 'confirm' })).status).toBe(409);
  });

  it('после обработки события — по-прежнему 409; значение «устарело», текст сохранён', async () => {
    await processEvents();
    const r = await put(s.eng1, draftB.id, 'tz_text', { action: 'set', value: 'Кровля — профнастил С-44', bases: [{ type: 'requirement_revision', id: req.tz.revisionId }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('basis_superseded');
    const d = await draftOf(s.eng1, draftB.id);
    expect(fieldOf(d, 'tz_text').latest).toMatchObject({ value: 'Кровля — профнастил С-44', stale: true });
    expect(d.issues.filter((i) => i.kind === 'stale').map((i) => i.fieldKey)).toContain('tz_text');
  });

  it('вторая линия: прямая запись версии по ревизии требования на заменённом ТЗ отвергается (23514)', async () => {
    const before = await versions(draftB.id, 'tz_direct');
    const err = await directWrite(draftB, 'tz_direct', { column: 'requirement_revision_id', type: 'requirement_revision', id: req.tz.revisionId });
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*document_revision_superseded/u);
    expect(await versions(draftB.id, 'tz_direct')).toBe(before);
  });

  it('новая редакция договора до перестроения графа: прежний факт не предлагается и не принимается; прямая запись — 23514', async () => {
    const factId = (await db.pool.query<{ id: string }>("SELECT e.id FROM evidence_fact e JOIN fact_state s ON s.evidence_fact_id = e.id WHERE e.fact_type = 'warranty_period' AND s.status = 'active' AND s.tender_id = $1", [s.tenderA])).rows[0]!.id;
    expect(fieldOf(await draftOf(s.eng1, draftB.id), 'warranty').systemProposals.map((p) => p.value)).toEqual(['36']);
    rev.contract2 = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор генподряда.pdf');
    await seedEvidenceRun(db.pool, rev.contract2, { pages: [{ blocks: ['Договор генподряда № Г-1 от 01.02.2026', PRICE, 'Гарантийный срок составляет 60 месяцев.'] }] });
    expect((await db.pool.query("SELECT status FROM fact_state WHERE evidence_fact_id = $1", [factId])).rows[0].status).toBe('active');
    const f = await fieldNow(s.eng1, draftB.id, 'warranty');
    expect(f.systemProposals).toEqual([]);
    const r = await act(s.eng1, draftB.id, 'warranty', f.etag, { action: 'accept_fact', evidenceFactId: factId });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('basis_superseded');
    expect(await versions(draftB.id, 'warranty')).toBe(0);
    const err = await directWrite(draftB, 'warranty', { column: 'evidence_fact_id', type: 'evidence_fact', id: factId });
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*document_revision_superseded/u);
  });
});

describe('R11-03, R11-01, R11-02 — другие цепочки и вторая линия 0030', () => {
  it('новая редакция письма: значение по требованию из письма — 409 basis_superseded (mail_message_revision_superseded)', async () => {
    const again = await importEml(s.manager, worker, box, eml({ messageId: 'forms-r11@example.test', subject: 'Аванс', text: `${SECRET_LETTER} Уточнение заказчика.` }));
    expect(again.createdRevision, JSON.stringify(again)).toBe(true);
    const r = await put(s.manager, draftB.id, 'req_text', { action: 'set', value: SECRET_REQ, bases: [{ type: 'requirement_revision', id: req.mail.revisionId }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ cause: 'mail_message_revision_superseded' })] });
  });

  it('функция актуальности раскрывает каждое основание тендера до исходных фрагментов', async () => {
    const r = await db.pool.query<{ kind: string; id: string; problem: string | null; source: string | null }>(
      `WITH b AS (
         SELECT 'requirement_revision' AS kind, id, field_basis_problem($2, NULL, NULL, id, NULL) AS problem,
                (SELECT min(change_basis_supersession($2, f.id, NULL)) FROM field_basis_source_fragments(NULL, NULL, r.id, NULL) AS f(id)) AS source
           FROM requirement_revision r WHERE r.tender_id = $1
         UNION ALL
         SELECT 'decision', id, field_basis_problem($2, NULL, id, NULL, NULL),
                (SELECT min(change_basis_supersession($2, f.id, NULL)) FROM field_basis_source_fragments(NULL, d.id, NULL, NULL) AS f(id))
           FROM decision d WHERE d.tender_id = $1 AND d.decision_type = 'requirement_decision'
         UNION ALL
         SELECT 'evidence_fact', evidence_fact_id, field_basis_problem($2, NULL, NULL, NULL, evidence_fact_id),
                (SELECT min(change_basis_supersession($2, f.id, NULL)) FROM field_basis_source_fragments(NULL, NULL, NULL, s.evidence_fact_id) AS f(id))
           FROM fact_state s WHERE s.tender_id = $1)
       SELECT * FROM b`,
      [s.tenderA, s.stageA],
    );
    expect(r.rows.filter((x) => x.source !== null).length).toBeGreaterThan(0);
    // Заменённый источник всегда даёт проблему основания (сама сущность может дать свою причину раньше).
    expect(r.rows.filter((x) => x.source !== null && x.problem === null)).toEqual([]);
  });

  it('вторая линия: обсуждение со значением без ссылки на источник и с подменённым значением отвергается (23514)', async () => {
    const f = await fieldNow(s.manager, draftB.id, 'price_mln');
    const write = async (value: string, withSource: boolean) => {
      const c: pg.PoolClient = await db.pool.connect();
      try {
        await c.query('BEGIN');
        const prev = (await c.query<{ id: string; version: number }>('SELECT id, version FROM draft_field_version WHERE field_id = $1 ORDER BY version DESC LIMIT 1', [f.fieldId])).rows[0]!;
        await c.query(
          `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, previous_version_id, value_from_version_id, comment, actor_user_id)
           VALUES ($1, $2, $3, $4, $5, 'needs_discussion', 'manual', $6, $7, 'обсудить', $8)`,
          [f.fieldId, draftB.id, s.tenderA, prev.version + 1, JSON.stringify(value), prev.id, withSource ? prev.id : null, s.ids.eng1],
        );
        await c.query('COMMIT');
        return null;
      } catch (x) {
        await c.query('ROLLBACK').catch(() => undefined);
        return x as { code?: string; message?: string };
      } finally {
        c.release();
      }
    };
    expect(`${(await write('25', false))?.code}`).toBe('23514');
    expect(`${(await write('26', true))?.code}`).toBe('23514');
    expect(await write('25', true)).toBeNull();
  });

  it('решение не по требованию основанием поля не принимается: API — 409, БД — 23514', async () => {
    const other = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO decision (tender_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
         VALUES ($1, 'import_item', gen_random_uuid(), 'import_item_disposition', 'Решение по элементу импорта', 'проверка', $2) RETURNING id`,
        [s.tenderA, s.ids.manager],
      )
    ).rows[0]!.id;
    const r = await put(s.manager, draftB.id, 'decision_text', { action: 'set', value: 'по решению импорта', bases: [{ type: 'decision', id: other }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('decision_basis_unsupported');
    const err = await directWrite(draftB, 'decision_text', { column: 'decision_id', type: 'decision', id: other });
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*решение по требованию/u);
  });
});
