// Этап 16, передача 16-3 (Review 16-2, R16-02): вопросы, которые вела прежняя версия. Миграция 0042 восстанавливает
// прежние связи с требованиями из аудита команд: связь при создании известна всегда, а правка черновика могла её
// сменить. Одна правка до обновления — история установлена полностью; две и более — промежуточные связи нигде не
// записаны, вопрос получает отметку и закрывается по всем требованиям этапа. Обычные вопросы остаются открытыми.
// Сценарий независимого ревьюера — в reviewRegressions16b.test.ts. Данные поддельные.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createDraft, createTemplateWithRevision, demoSchema, draftOf, fieldOf, setValue } from './formsFixtures.ts';
import { idem, type TestClient } from './helpers.ts';
import { buildLegacyStage, LATEST_MIGRATION, legacyPatch, legacyQuestion, type ILegacyStage } from './legacyQuestionFixtures.ts';
import { callTool, issueToken, mcpClient, startMcp } from './mcpFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SECRET = 'ПРЕЖНЯЯ-СВЯЗЬ-16-48215';

interface IQuestionView {
  id: string;
  visible: boolean;
  text: string | null;
  status: string;
  requirementId: string | null;
  basisUnknown: boolean;
  rowVersion: number;
}

let legacy: ILegacyStage;
let applied: number;
const q = {} as Record<'detached' | 'never' | 'openDetached' | 'linked' | 'relinked' | 'edited' | 'form' | 'direct' | 'otherStage', string>;
const versionsBefore = new Map<string, number>();

const questions = async (client: TestClient, stageId: string): Promise<IQuestionView[]> => {
  const r = await client.get(`/stages/${stageId}/customer-questions`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as IQuestionView[];
};
const questionOf = async (client: TestClient, id: string, stageId = legacy.st.s.stageA): Promise<IQuestionView> => (await questions(client, stageId)).find((x) => x.id === id)!;
const basisOf = async (id: string): Promise<{ ids: string[]; unknown: boolean }> =>
  (await legacy.db.pool.query<{ ids: string[]; unknown: boolean }>('SELECT basis_requirement_ids AS ids, basis_unknown AS unknown FROM customer_question WHERE id = $1', [id])).rows[0]!;
const sqlCode = async (sql: string, params: unknown[]): Promise<string | null> => {
  try {
    await legacy.db.pool.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};
const ok = async (p: Promise<{ status: number; text: string }>): Promise<void> => {
  const r = await p;
  expect(r.status, r.text).toBe(200);
};

beforeAll(async () => {
  legacy = await buildLegacyStage('basis', SECRET);
  const { db, st } = legacy;
  const { s } = st;
  const patch = (client: TestClient, id: string, body: Record<string, unknown>) => ok(legacyPatch(db, client, id, body));

  // Создан по закрытому требованию и отвязан одной правкой: случай Review 16-2.
  q.detached = await legacyQuestion(s.manager, s.stageA, { text: `Подтвердите ${SECRET}`, requirementId: legacy.closedRequirement });
  await patch(s.manager, q.detached, { requirementId: null });
  // Обычные вопросы: без связи и отправлен; по открытому требованию и отвязан; из поля приложения.
  q.never = await legacyQuestion(s.eng1, s.stageA, { text: 'Уточните срок поставки окон' });
  await patch(s.eng1, q.never, { status: 'sent' });
  q.openDetached = await legacyQuestion(s.eng1, s.stageA, { text: 'Уточните уклон кровли', requirementId: legacy.openRequirement });
  await patch(s.eng1, q.openDetached, { requirementId: null });
  const template = await createTemplateWithRevision(s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions') });
  const draft = await createDraft(s.eng1, s.stageA, template.revisionId, 'Ключевые условия');
  await setValue(s.eng1, draft.id, 'site_upkeep_month', '25');
  const field = fieldOf(await draftOf(s.eng1, draft.id), 'site_upkeep_month');
  const discussed = await act(s.eng1, draft.id, 'site_upkeep_month', field.etag, { action: 'discuss', comment: 'Уточнить сумму у заказчика', createQuestion: true });
  expect(discussed.status, discussed.text).toBe(200);
  q.form = discussed.body.field.latest.customerQuestionId as string;
  await patch(s.eng1, q.form, { status: 'sent' });
  // По закрытому требованию, связь не снималась.
  q.linked = await legacyQuestion(s.manager, s.stageA, { text: `Действует ли шифр ${SECRET}?`, requirementId: legacy.closedRequirement });
  // Две правки черновика: связь с закрытым требованием поставлена и снята — в аудите её нет.
  q.relinked = await legacyQuestion(s.manager, s.stageA, { text: `Скопировано ${SECRET}` });
  await patch(s.manager, q.relinked, { requirementId: legacy.closedRequirement });
  await patch(s.manager, q.relinked, { requirementId: null });
  // Две правки черновика без связей: по аудиту от предыдущего случая не отличить.
  q.edited = await legacyQuestion(s.eng2, s.stageA, { text: 'Черновик вопроса' });
  await patch(s.eng2, q.edited, { text: 'Уточните марку стекла витражей' });
  await patch(s.eng2, q.edited, { status: 'sent' });
  // Запись без команды создания: путь создания неизвестен.
  q.direct = (
    await db.pool.query<{ id: string }>("INSERT INTO customer_question (tender_id, stage_id, text, created_by, updated_by) VALUES ($1, $2, 'Вопрос без записи создания', $3, $3) RETURNING id", [s.tenderA, s.stageA, s.ids.manager])
  ).rows[0]!.id;
  // Этап без требований: закрывать нечем.
  q.otherStage = await legacyQuestion(s.eng3, s.stageB, { text: 'Вопрос тендера Б' });
  await patch(s.eng3, q.otherStage, { text: 'Вопрос тендера Б, правка' });
  await patch(s.eng3, q.otherStage, { text: 'Вопрос тендера Б, вторая правка' });

  for (const r of (await db.pool.query<{ id: string; v: string }>('SELECT id, row_version AS v FROM customer_question')).rows) versionsBefore.set(r.id, Number(r.v));
  applied = await legacy.upgrade();
});
afterAll(async () => {
  await legacy?.close();
});

describe('R16-02: обновление базы с вопросами прежней версии', () => {
  it('применены миграции после 0040; версии строк вопросов восстановлением не меняются', async () => {
    expect(applied).toBe(LATEST_MIGRATION - 40);
    const after = (await legacy.db.pool.query<{ id: string; v: string }>('SELECT id, row_version AS v FROM customer_question')).rows;
    expect(after).toHaveLength(versionsBefore.size);
    for (const r of after) expect(Number(r.v), r.id).toBe(versionsBefore.get(r.id));
  });

  it('связь, снятая прежней версией, восстановлена из аудита: вопрос закрыт тем, кто не читает основание требования', async () => {
    const { s } = legacy.st;
    expect(await basisOf(q.detached)).toEqual({ ids: [legacy.closedRequirement], unknown: false });
    for (const blind of [s.eng1, s.eng2]) {
      expect(await questionOf(blind, q.detached)).toMatchObject({ visible: false, text: null, requirementId: null, basisUnknown: false });
      expect((await blind.get(`/stages/${s.stageA}/customer-questions`)).text).not.toContain(SECRET);
    }
    expect(await questionOf(s.manager, q.detached)).toMatchObject({ visible: true, text: `Подтвердите ${SECRET}` });
    // Через чат-клиент пользователя без права на договор.
    const endpoint = await startMcp(legacy.st.app);
    try {
      const token = await issueToken(s.eng1);
      const c = await mcpClient(endpoint.url, token.token);
      const listed = await callTool(c, 'list_questions', { tenderId: s.tenderA, stageId: s.stageA });
      await c.close();
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.text).not.toContain(SECRET);
    } finally {
      await endpoint.close();
    }
  });

  it('закрытый после обновления вопрос нельзя изменить и отметить отправленным без права на прежнее основание', async () => {
    const { s } = legacy.st;
    for (const body of [{ status: 'sent' }, { status: 'closed' }, { text: 'Подмена' }, { requirementId: legacy.openRequirement }]) {
      const r = await legacyPatch(legacy.db, s.eng1, q.detached, body);
      expect(r.status, r.text).toBe(409);
      expect(r.body.current).toMatchObject({ reason: 'restricted_fragments', object: 'question' });
      expect(r.text).not.toContain(SECRET);
    }
    // Читающий основание ведёт вопрос как раньше; для остальных он остаётся закрытым.
    await ok(legacyPatch(legacy.db, s.manager, q.detached, { status: 'sent' }));
    expect(await questionOf(s.eng1, q.detached)).toMatchObject({ visible: false, text: null, status: 'sent' });
    expect(await basisOf(q.detached)).toEqual({ ids: [legacy.closedRequirement], unknown: false });
  });

  it('контроль: обычные вопросы прежней версии остаются открытыми и ведутся как раньше', async () => {
    const { s } = legacy.st;
    expect(await basisOf(q.never)).toEqual({ ids: [], unknown: false });
    expect(await basisOf(q.form)).toEqual({ ids: [], unknown: false });
    expect(await basisOf(q.openDetached)).toEqual({ ids: [legacy.openRequirement], unknown: false });
    for (const reader of [s.eng1, s.eng2, s.manager]) {
      expect(await questionOf(reader, q.never)).toMatchObject({ visible: true, text: 'Уточните срок поставки окон', status: 'sent', basisUnknown: false });
      expect(await questionOf(reader, q.openDetached)).toMatchObject({ visible: true, text: 'Уточните уклон кровли', requirementId: null, basisUnknown: false });
      expect(await questionOf(reader, q.form)).toMatchObject({ visible: true, status: 'sent', basisUnknown: false });
    }
    await ok(legacyPatch(legacy.db, s.eng2, q.openDetached, { status: 'sent' }));
    await ok(legacyPatch(legacy.db, s.eng2, q.never, { status: 'answered', answerNote: 'Поставка в ноябре' }));
    expect(await questionOf(s.eng1, q.never)).toMatchObject({ visible: true, status: 'answered' });
  });

  it('контроль: вопрос, связанный с закрытым требованием и сейчас, закрыт как раньше', async () => {
    const { s } = legacy.st;
    expect(await basisOf(q.linked)).toEqual({ ids: [legacy.closedRequirement], unknown: false });
    expect(await questionOf(s.eng1, q.linked)).toMatchObject({ visible: false, text: null, requirementId: legacy.closedRequirement });
    expect(await questionOf(s.manager, q.linked)).toMatchObject({ visible: true });
  });

  it('история не установлена — две правки черновика или нет записи создания: вопрос закрыт по всем требованиям этапа', async () => {
    const { s } = legacy.st;
    const all = [legacy.closedRequirement, legacy.openRequirement].sort();
    for (const id of [q.relinked, q.edited, q.direct]) {
      const basis = await basisOf(id);
      expect(basis.unknown, id).toBe(true);
      expect([...basis.ids].sort(), id).toEqual(all);
      // Кто не читает основание хотя бы одного требования этапа — не читает и вопрос, и не ведёт его.
      for (const blind of [s.eng1, s.eng2]) expect(await questionOf(blind, id)).toMatchObject({ visible: false, text: null, basisUnknown: true });
      const blocked = await legacyPatch(legacy.db, s.eng1, id, { status: 'closed' });
      expect(blocked.status, blocked.text).toBe(409);
      expect(blocked.body.current).toMatchObject({ reason: 'restricted_fragments' });
      // Кто читает основания всех требований — читает вопрос.
      expect(await questionOf(s.manager, id)).toMatchObject({ visible: true, basisUnknown: true });
    }
    expect((await s.eng1.get(`/stages/${s.stageA}/customer-questions`)).text).not.toContain(SECRET);
    expect(await questionOf(s.manager, q.relinked)).toMatchObject({ text: `Скопировано ${SECRET}` });
    await ok(legacyPatch(legacy.db, s.manager, q.relinked, { status: 'sent' }));
    expect(await questionOf(s.eng1, q.relinked)).toMatchObject({ visible: false, text: null, status: 'sent' });
  });

  it('контроль: в этапе без требований вопрос с неустановленной историей остаётся открытым', async () => {
    const { s } = legacy.st;
    expect(await basisOf(q.otherStage)).toEqual({ ids: [], unknown: true });
    expect(await questionOf(s.eng3, q.otherStage, s.stageB)).toMatchObject({ visible: true, text: 'Вопрос тендера Б, вторая правка', basisUnknown: true });
    await ok(legacyPatch(legacy.db, s.eng3, q.otherStage, { status: 'sent' }));
  });

  it('вторая линия: отметку ставит только миграция; у новых вопросов её нет, их история ведётся охранником', async () => {
    const { s } = legacy.st;
    expect(await sqlCode('UPDATE customer_question SET basis_unknown = false, updated_by = $2, row_version = row_version + 1 WHERE id = $1', [q.edited, s.ids.manager])).toBe('55000');
    expect(await sqlCode('UPDATE customer_question SET basis_unknown = true, updated_by = $2, row_version = row_version + 1 WHERE id = $1', [q.never, s.ids.manager])).toBe('55000');
    expect(await sqlCode("UPDATE customer_question SET basis_requirement_ids = '{}', updated_by = $2, row_version = row_version + 1 WHERE id = $1", [q.edited, s.ids.manager])).toBeNull();
    expect((await basisOf(q.edited)).ids).toHaveLength(2);
    const inserted = await legacy.db.pool.query<{ id: string; unknown: boolean }>(
      "INSERT INTO customer_question (tender_id, stage_id, text, created_by, updated_by, basis_unknown) VALUES ($1, $2, 'Новый вопрос', $3, $3, true) RETURNING id, basis_unknown AS unknown",
      [s.tenderA, s.stageA, s.ids.manager],
    );
    expect(inserted.rows[0]!.unknown).toBe(false);
    // Новый вопрос после обновления: поставленная и снятая связь остаётся в истории.
    const created = await s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: `Новый ${SECRET}` }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ basisUnknown: false });
    const id = created.body.id as string;
    await ok(legacyPatch(legacy.db, s.manager, id, { requirementId: legacy.closedRequirement }));
    await ok(legacyPatch(legacy.db, s.manager, id, { requirementId: null }));
    expect(await basisOf(id)).toEqual({ ids: [legacy.closedRequirement], unknown: false });
    expect(await questionOf(s.eng1, id)).toMatchObject({ visible: false, text: null });
  });
});
