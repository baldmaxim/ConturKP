// Этап 10: причины изменений (проект §5.8, §6; D-030 В-10-8; I11, I12, A23). Модель предлагает вид причины с
// цитатами из закреплённого входа, человек подтверждает; без основания — «неизвестно». Права запустившего — текущие:
// перед моделью и перед каждой пачкой (как R09-04); производный текст — только при чтении всех оснований (R08-02);
// новая редакция основания отмечает подтверждённую причину и гасит открытую гипотезу (D-029).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatModelResult, IChatCompleteInput, IChatCompletion, IModelGatewayChat } from '../packages/adapters/src/index.ts';
import { compare, decide, E, lineageOf, unitOf, units, buildEcon, closeEcon, type IEcon, type IUnitView } from './economicsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';
import { buildIndex, fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

// Модель с идентичностью, которую закрепляет сервер (fake / fake-chat / test), записывает каждый запрос.
class RecordingChat implements IModelGatewayChat {
  readonly providerId = 'fake' as const;
  readonly model = 'fake-chat';
  readonly version = 'test';
  readonly maxInputChars = 100_000;
  readonly inferenceConfig = { temperature: 0 };
  readonly calls: IChatCompleteInput[] = [];
  async complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>> {
    this.calls.push(input);
    return { ok: true, value: { content: '{"reasons":[]}', startedAt: new Date(), finishedAt: new Date(), promptTokens: null, completionTokens: null } };
  }
}

const TXT = {
  plaster: 'Штукатурка стен: площадь увеличена до 110 м2, расценка штукатурки изменена.',
  paint: 'Окраска фасада добавлена по требованию заказчика.',
  waste: 'Вывоз мусора оплачивается по курсу доллара на дату платежа — секрет-письма-7731.',
};

let db: ITestDb;
let e: IEcon;
let box: string;
let tzRev: string;
let cmp = '';
let list: IUnitView[] = [];
const frag: Record<string, string> = {};

const runReasons = async (client: TestClient, unitIds: string[], chat: IModelGatewayChat = fakeModel()) => {
  const r = await client.post(`/comparisons/${cmp}/reason-runs`, { unitIds }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return { id: r.body.id as string, run: async () => {
    await drain(workerWithChat(db, e.config, chat, `reasons-${(r.body.id as string).slice(0, 8)}`));
    const v = await client.get(`/reason-runs/${r.body.id}`);
    expect(v.status, v.text).toBe(200);
    return v.body as { status: string; coverage: Record<string, unknown> };
  } };
};

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  // Основания: ТЗ (штукатурка, окраска) и письмо заказчика о вывозе мусора — письмо читает только инженер 1.
  tzRev = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  const run = await seedEvidenceRun(db.pool, tzRev, { pages: [{ blocks: [TXT.plaster, TXT.paint] }] });
  frag.plaster = await fragmentIdOf(db.pool, run, TXT.plaster);
  frag.paint = await fragmentIdOf(db.pool, run, TXT.paint);
  box = await createMailbox(e.s.admin, 'econ@contractor.example.test', 'Ящик экономики');
  await setMailAccess(e.s.admin, box, e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  const letter = await importEml(e.s.eng1, e.worker, box, eml({ messageId: 'waste-10@example.test', subject: 'Вывоз мусора', text: TXT.waste }));
  await linkMail(e.s.eng1, letter.messageId!, e.s.tenderA, e.s.stageA);
  frag.waste = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [letter.revisionId])).rows[0]!.id;
  await setWorkingSet(e.s.manager, e.s.stageA, [tzRev], true);
  await fixScope(e.s.manager, e.s.stageA);
  await buildIndex(db, e.worker);
  // Сравнение с подтверждёнными парами (как в economics.test.ts).
  const first = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
  const { body, etag } = await lineageOf(e.s.eng1, first.id);
  const ok = await decide(e.s.eng1, first.id, etag, [
    ...body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })),
    { fromPositionId: E.p.B, toPositionId: E.q.B1, status: 'confirmed' },
    { fromPositionId: E.p.B, toPositionId: E.q.B2, status: 'confirmed' },
  ]);
  expect(ok.status, ok.text).toBe(201);
  cmp = (await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2)).id;
  list = await units(e.s.eng1, cmp);
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

const unitsNow = (client: TestClient = e.s.eng1) => units(client, cmp);

describe('гипотезы модели и подтверждение человеком (I11, I12, A23)', () => {
  it('модель предлагает вид причины с цитатой; изменение без документа — гипотезы нет, причина «неизвестно»', async () => {
    const A = unitOf(list, E.q.A);
    const G = unitOf(list, E.q.G);
    const C = unitOf(list, E.q.C);
    const Ew = unitOf(list, E.q.E);
    const r = await runReasons(e.s.eng1, [A.id, G.id, C.id, Ew.id]);
    const done = await r.run();
    expect(done.status, JSON.stringify(done.coverage)).toBe('completed');
    expect(done.coverage).toMatchObject({ units: 4, suggestions: 3 });
    const now = await unitsNow();
    expect(unitOf(now, E.q.A).suggestions).toEqual([expect.objectContaining({ status: 'open', reasonKind: 'document', restricted: false, evidence: [expect.objectContaining({ fragmentId: frag.plaster })] })]);
    expect(unitOf(now, E.q.E).suggestions).toEqual([expect.objectContaining({ reasonKind: 'answer', evidence: [expect.objectContaining({ fragmentId: frag.waste })] })]);
    // A23: цена стяжки изменилась без документа — гипотезы нет; причина не выставлена системой.
    expect(unitOf(now, E.q.C).suggestions).toEqual([]);
    expect(unitOf(now, E.q.C).explanation).toBeNull();
    // Гипотеза модели сама причиной не становится.
    expect(unitOf(now, E.q.A).explanation).toBeNull();
  });

  it('производный текст гипотезы по письму скрыт от инженера без mail.read (R08-02)', async () => {
    const forEng2 = unitOf(await unitsNow(e.s.eng2), E.q.E);
    expect(forEng2.suggestions[0]).toMatchObject({ restricted: true, rationale: null });
    expect(JSON.stringify(forEng2)).not.toContain('секрет-письма-7731');
    const forEng1 = unitOf(await unitsNow(e.s.eng1), E.q.E);
    expect(forEng1.suggestions[0]).toMatchObject({ restricted: false });
    // Принять гипотезу, оснований которой не читаешь, нельзя.
    const s = forEng2.suggestions[0]!;
    const denied = await e.s.eng2.post(`/change-reason-suggestions/${s.id}/accept`, {}, { headers: { 'If-Match': `"${s.id}:${s.rowVersion}"` } });
    expect(denied.status).toBe(409);
    expect(denied.body.current.reason).toBe('restricted_fragments');
  });

  it('инженер принимает гипотезу: причина «подтверждено» с основанием; повтор по старой версии — 412', async () => {
    const s = unitOf(await unitsNow(), E.q.A).suggestions[0]!;
    const ok = await e.s.eng1.post(`/change-reason-suggestions/${s.id}/accept`, {}, { headers: { 'If-Match': `"${s.id}:${s.rowVersion}"` } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'accepted', explanationId: expect.any(String) });
    expect((await e.s.eng1.post(`/change-reason-suggestions/${s.id}/accept`, {}, { headers: { 'If-Match': `"${s.id}:${s.rowVersion}"` } })).status).toBe(412);
    const A = unitOf(await unitsNow(), E.q.A);
    expect(A.explanation).toMatchObject({ reasonKind: 'document', reasonStatus: 'confirmed', restricted: false, basisChanged: false, bases: [expect.objectContaining({ fragmentId: frag.plaster })] });
  });

  it('новая редакция ТЗ: подтверждённая причина отмечена «основание изменилось», открытая гипотеза погашена; история сохранена', async () => {
    const rev2 = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
    expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [rev2])).rows[0].supersedes_revision_id).toBe(tzRev);
    await e.worker.maintain({ checkModel: false });
    await drain(e.worker);
    const now = await unitsNow();
    expect(unitOf(now, E.q.A).explanation).toMatchObject({ reasonStatus: 'confirmed', basisChanged: true });
    expect(unitOf(now, E.q.G).suggestions).toEqual([expect.objectContaining({ status: 'expired' })]);
    const v = await e.s.eng1.get(`/comparisons/${cmp}`);
    expect(v.body.outdated).toMatchObject({ value: true, invalidatedExplanations: 1 });
    // Погашенную гипотезу принять нельзя.
    const g = unitOf(now, E.q.G).suggestions[0]!;
    const late = await e.s.eng1.post(`/change-reason-suggestions/${g.id}/accept`, {}, { headers: { 'If-Match': `"${g.id}:${g.rowVersion}"` } });
    expect(late.status).toBe(409);
    expect(late.body.current.reason).toBe('suggestion_expired');
  });
});

describe('права запустившего — текущие (как R09-04)', () => {
  it('отзыв mail.read до задания: письмо в модель не уходит, прогон «с пробелами»', async () => {
    const Ew = unitOf(list, E.q.E);
    const chat = new RecordingChat();
    const r = await runReasons(e.s.eng1, [Ew.id], chat);
    await setMailAccess(e.s.admin, box, e.s.ids.eng1, []);
    const v = await r.run();
    expect(chat.calls).toHaveLength(0);
    expect(v.status).toBe('completed_with_gaps');
    expect(String(v.coverage.gap)).toMatch(/недоступных запустившему/u);
    await setMailAccess(e.s.admin, box, e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  });

  it('снятие с тендера до задания: модель не вызывается, прогон «с пробелами» с причиной', async () => {
    const A = unitOf(list, E.q.G);
    const r = await e.s.eng2.post(`/comparisons/${cmp}/reason-runs`, { unitIds: [A.id] }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    const card = await e.s.admin.get(`/tenders/${e.s.tenderA}`);
    const del = await e.s.admin.delete(`/tenders/${e.s.tenderA}/members/${e.s.ids.eng2}`, { headers: { 'If-Match': card.headers.etag as string } });
    expect([200, 204], del.text).toContain(del.status);
    const chat = new RecordingChat();
    await drain(workerWithChat(db, e.config, chat, 'reasons-removed'));
    const run = (await db.pool.query<{ status: string; coverage: { gap?: string } }>('SELECT status, coverage FROM reason_run WHERE id = $1', [r.body.id])).rows[0]!;
    expect(chat.calls).toHaveLength(0);
    expect(run.status).toBe('completed_with_gaps');
    expect(run.coverage.gap).toMatch(/больше не участник тендера/u);
  });
});

describe('гонка порядка заданий (как R09-01)', () => {
  it('событие новой распознанной версии обработано раньше, чем задание модели записало гипотезы: гипотеза сразу погашена', async () => {
    const G = unitOf(list, E.q.G);
    const r = await e.s.eng1.post(`/comparisons/${cmp}/reason-runs`, { unitIds: [G.id] }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    // Новое распознавание той же редакции ТЗ заменяет прогон, из которого взяты кандидаты-основания.
    await seedEvidenceRun(db.pool, tzRev, { pages: [{ blocks: [TXT.plaster, TXT.paint] }] });
    const w = workerWithChat(db, e.config, fakeModel(), 'race-10');
    await w.maintain({ checkModel: false });
    for (let i = 0; i < 20 && (await w.runOnce(['stage.invalidate'])); i += 1);
    expect((await db.pool.query("SELECT 1 FROM job WHERE kind = 'economics.reasons' AND status = 'queued' AND payload->>'runId' = $1", [r.body.id])).rowCount).toBe(1);
    for (let i = 0; i < 5 && (await w.runOnce(['economics.reasons'])); i += 1);
    const run = (await db.pool.query<{ status: string; coverage: { suggestions: number; expiredOnWrite: number } }>('SELECT status, coverage FROM reason_run WHERE id = $1', [r.body.id])).rows[0]!;
    expect(run.coverage).toMatchObject({ suggestions: 1, expiredOnWrite: 1 });
    const s = (await db.pool.query<{ status: string }>('SELECT status FROM change_reason_suggestion WHERE run_id = $1', [r.body.id])).rows;
    expect(s).toEqual([{ status: 'expired' }]);
  });
});
