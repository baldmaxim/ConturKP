// Этап 11, предложения и устаревание (D-031 В-11-5, В-11-6; проект §5.2, §5.6, §6): предложение системы из
// действующего факта и предложение модели становятся значением только принятием человека; ложная цитата и число не
// из цитаты отбрасываются гейтом; ручная правка после предложения LLM видна в истории; права запустившего — текущие;
// новая редакция основания помечает значение «устарело», текст не меняется; заменённое основание значение не
// подтверждает (API и вторая линия БД).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatModelResult, IChatCompleteInput, IChatCompletion, IModelGatewayChat } from '../packages/adapters/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { act, createDraft, createTemplateWithRevision, demoSchema, draftOf, fieldOf, setValue, type IDraftView } from './formsFixtures.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';
import { buildIndex, fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const ADVANCE = '3.1. Аванс составляет 30% от цены договора.';
const WARRANTY = '6.1. Гарантийный срок составляет 36 месяцев.';

// Модель с заданным ответом (идентичность — как у поддельной модели, закреплённой сервером).
class ScriptedChat implements IModelGatewayChat {
  readonly providerId = 'fake' as const;
  readonly model = 'fake-chat';
  readonly version = 'test';
  readonly maxInputChars = 100_000;
  readonly inferenceConfig = { temperature: 0 };
  readonly calls: IChatCompleteInput[] = [];
  private readonly content: (input: IChatCompleteInput) => string;
  constructor(content: (input: IChatCompleteInput) => string) {
    this.content = content;
  }
  async complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>> {
    this.calls.push(input);
    return { ok: true, value: { content: this.content(input), startedAt: new Date(), finishedAt: new Date(), promptTokens: null, completionTokens: null } };
  }
}

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let draft: IDraftView;
let docRev = '';
const frag: Record<string, string> = {};
const config = testConfig();

const processEvents = async () => {
  await worker.maintain({ checkModel: false });
  await drain(worker);
};

const startRun = async (chat: IModelGatewayChat, fieldKeys: string[] | null = null) => {
  const r = await s.eng1.post(`/application-drafts/${draft.id}/suggestion-runs`, { fieldKeys }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return {
    id: r.body.id as string,
    run: async () => {
      await drain(workerWithChat(db, config, chat, `forms-${(r.body.id as string).slice(0, 8)}`));
      return (await s.eng1.get(`/field-suggestion-runs/${r.body.id}`)).body as { status: string; coverage: Record<string, unknown> };
    },
  };
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = workerWithChat(db, config, fakeModel(), 'forms-worker');
  docRev = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор генподряда.pdf');
  const run = await seedEvidenceRun(db.pool, docRev, { pages: [{ blocks: ['Договор генподряда № Г-1 от 01.02.2026', ADVANCE, WARRANTY] }] });
  frag.advance = await fragmentIdOf(db.pool, run, ADVANCE);
  frag.warranty = await fragmentIdOf(db.pool, run, WARRANTY);
  await setWorkingSet(s.manager, s.stageA, [docRev], true);
  await fixScope(s.manager, s.stageA);
  await buildIndex(db, worker);
  await worker.scheduleFactExtraction();
  await processEvents();
  const key = await createTemplateWithRevision(s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions') });
  draft = await createDraft(s.eng1, s.stageA, key.revisionId, 'Ключевые условия');
});
afterAll(async () => {
  await db.drop();
});

describe('предложение системы из факта (D-031 В-11-6)', () => {
  it('действующий факт того же смысла — предложение; значением становится только после «Принять»', async () => {
    const f = fieldOf(await draftOf(s.eng1, draft.id), 'warranty_months');
    expect(f.latest).toBeNull();
    expect(f.systemProposals).toEqual([expect.objectContaining({ value: '36', restricted: false })]);
    const r = await act(s.eng1, draft.id, 'warranty_months', f.etag, { action: 'accept_fact', evidenceFactId: f.systemProposals[0]!.evidenceFactId });
    expect(r.status, r.text).toBe(200);
    expect(r.body.field.latest).toMatchObject({ value: '36', origin: 'system_suggestion', state: 'accepted', bases: [expect.objectContaining({ basisType: 'evidence_fact', problem: null })] });
  });

  it('значение, расходящееся с действующим фактом, — противоречие в списке незавершённых', async () => {
    await setValue(s.eng1, draft.id, 'advance_percent', '25');
    const d = await draftOf(s.eng1, draft.id);
    expect(d.issues.filter((i) => i.kind === 'contradiction').map((i) => [i.fieldKey, i.message])).toEqual([['advance_percent', 'противоречие — факт «Размер аванса»: значение расходится с действующим фактом']]);
  });
});

describe('предложения модели (D-031 В-11-5)', () => {
  it('модель предлагает по цитате; принятие — версия с основанием и цитатой; ручная правка после — связь в истории', async () => {
    const run = await startRun(fakeModel(), ['advance_percent']);
    const done = await run.run();
    expect(done.status, JSON.stringify(done.coverage)).toBe('completed');
    expect(done.coverage).toMatchObject({ suggestions: 1, falseQuotes: 0 });
    const f = fieldOf(await draftOf(s.eng1, draft.id), 'advance_percent');
    expect(f.latest).toMatchObject({ value: '25', origin: 'manual' });
    const sug = f.suggestions[0]!;
    expect(sug).toMatchObject({ status: 'open', value: '30', evidence: [expect.objectContaining({ fragmentId: frag.advance })] });
    const ok = await s.eng1.post(`/field-suggestions/${sug.id}/accept`, {}, { headers: { 'If-Match': sug.etag } });
    expect(ok.status, ok.text).toBe(200);
    const after = fieldOf(await draftOf(s.eng1, draft.id), 'advance_percent');
    expect(after.latest).toMatchObject({ value: '30', origin: 'model_suggestion', bases: [expect.objectContaining({ fragmentId: frag.advance, quote: expect.stringContaining('30%') })] });
    await setValue(s.eng2, draft.id, 'advance_percent', '30.5');
    const h = await s.eng1.get(`/application-drafts/${draft.id}/fields/advance_percent/history`);
    expect(h.body.items.slice(0, 2).map((v: { origin: string; state: string; actor: { name: string }; previousVersionId: string | null; id: string }) => [v.origin, v.state, v.actor.name])).toEqual([
      ['manual', 'edited', 'Инженер 2'],
      ['model_suggestion', 'accepted', 'Инженер 1'],
    ]);
    expect(h.body.items[0].previousVersionId).toBe(h.body.items[1].id);
    await setValue(s.eng1, draft.id, 'advance_percent', '30');
  });

  it('ложная цитата и число не из цитаты отбрасываются гейтом: предложений нет, счётчик в охвате', async () => {
    const chat = new ScriptedChat((input) => {
      const fields = (JSON.parse(input.user) as { fields: { fieldKey: string; fragments: { label: string; text: string }[] }[] }).fields;
      const labelOf = (key: string, text: string) => fields.find((f) => f.fieldKey === key)!.fragments.find((x) => x.text === text)!.label;
      return JSON.stringify({
        fields: [
          // Фразы нет во фрагменте.
          { fieldKey: 'warranty_months', value: '60', rationale: 'по договору', citations: [{ evidence: labelOf('warranty_months', WARRANTY), quote: 'Гарантийный срок составляет 60 месяцев' }] },
          // Цитата верна, но числа 35 в ней нет.
          { fieldKey: 'advance_percent', value: '35', rationale: 'по договору', citations: [{ evidence: labelOf('advance_percent', ADVANCE), quote: 'Аванс составляет 30% от цены договора' }] },
        ],
      });
    });
    const run = await startRun(chat, ['warranty_months', 'advance_percent']);
    const done = await run.run();
    expect(chat.calls).toHaveLength(1);
    expect(done.coverage).toMatchObject({ suggestions: 0, falseQuotes: 2 });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM field_suggestion WHERE run_id = $1', [run.id])).rows[0].n).toBe(0);
  });

  it('снятие запустившего с тендера до задания: модель не вызывается, прогон «с пробелами»', async () => {
    const r = await s.eng2.post(`/application-drafts/${draft.id}/suggestion-runs`, { fieldKeys: ['warranty_months'] }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    const card = await s.admin.get(`/tenders/${s.tenderA}`);
    const del = await s.admin.delete(`/tenders/${s.tenderA}/members/${s.ids.eng2}`, { headers: { 'If-Match': card.headers.etag as string } });
    expect([200, 204], del.text).toContain(del.status);
    const chat = new ScriptedChat(() => '{"fields":[]}');
    await drain(workerWithChat(db, config, chat, 'forms-removed'));
    const run = (await db.pool.query<{ status: string; coverage: { gap?: string } }>('SELECT status, coverage FROM field_suggestion_run WHERE id = $1', [r.body.id])).rows[0]!;
    expect(chat.calls).toHaveLength(0);
    expect(run).toMatchObject({ status: 'completed_with_gaps', coverage: { gap: expect.stringMatching(/больше не участник тендера/u) } });
  });
});

describe('устаревание без перезаписи (D-031 В-11-5, В-11-6; уроки R10-01, R10-03)', () => {
  it('новая редакция договора: принятое по цитате значение «устарело», текст сохранён; подтвердить по старой цитате нельзя; открытое предложение погашено', async () => {
    await setValue(s.eng1, draft.id, 'advance_percent', '30', [{ type: 'fragment', id: frag.advance! }]);
    const open = await startRun(fakeModel(), ['warranty_months']);
    await open.run();
    const sug = fieldOf(await draftOf(s.eng1, draft.id), 'warranty_months').suggestions.find((x) => x.status === 'open')!;
    expect(sug).toBeTruthy();
    const rev2 = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор генподряда.pdf');
    expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [rev2])).rows[0].supersedes_revision_id).toBe(docRev);
    // До обработки события: принять предложение по заменённой цитате нельзя (по текущему состоянию).
    const early = await s.eng1.post(`/field-suggestions/${sug.id}/accept`, {}, { headers: { 'If-Match': sug.etag } });
    expect(early.status).toBe(409);
    expect(early.body.current.reason).toBe('basis_superseded');
    await processEvents();
    const f = fieldOf(await draftOf(s.eng1, draft.id), 'advance_percent');
    expect(f.latest).toMatchObject({ value: '30', stale: true });
    expect(f.latest!.bases.some((b) => b.problem === 'document_revision_superseded')).toBe(true);
    const d = await draftOf(s.eng1, draft.id);
    expect(d.issues.filter((i) => i.kind === 'stale').map((i) => i.fieldKey)).toContain('advance_percent');
    const confirm = await act(s.eng1, draft.id, 'advance_percent', f.etag, { action: 'confirm' });
    expect(confirm.status).toBe(409);
    expect(confirm.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ cause: 'document_revision_superseded' })] });
    expect(fieldOf(await draftOf(s.eng1, draft.id), 'warranty_months').suggestions.find((x) => x.id === sug.id)!.status).toBe('expired');
    // Ручной ввод без заменённого основания снимает «устарело».
    await setValue(s.eng1, draft.id, 'advance_percent', '30');
    expect(fieldOf(await draftOf(s.eng1, draft.id), 'advance_percent').latest).toMatchObject({ stale: false, origin: 'manual' });
  });

  it('вторая линия: прямая запись версии с заменённым основанием в обход API отвергается (23514)', async () => {
    const f = fieldOf(await draftOf(s.eng1, draft.id), 'retention_percent');
    const c = await db.pool.connect();
    let err: { code?: string; message?: string } | null = null;
    try {
      await c.query('BEGIN');
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO draft_field_version (field_id, draft_id, tender_id, version, value, state, origin, actor_user_id)
           VALUES ($1, $2, $3, 1, '"2"', 'edited', 'manual', $4) RETURNING id`,
          [f.fieldId, draft.id, s.tenderA, s.ids.eng1],
        )
      ).rows[0]!.id;
      await c.query("INSERT INTO draft_field_basis (field_version_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, s.tenderA, frag.advance]);
      await c.query('COMMIT');
    } catch (x) {
      err = x as { code?: string; message?: string };
      await c.query('ROLLBACK').catch(() => undefined);
    } finally {
      c.release();
    }
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*основание заменено или в конфликте \(document_revision_superseded\)/u);
  });
});
