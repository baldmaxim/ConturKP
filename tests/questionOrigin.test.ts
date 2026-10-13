// Этап 16, передача 16-2 (Review 16-1, R16-01; находка S16-12): происхождение вопроса заказчику. Вопрос из принятого
// предложения чата наследует закрытость цитат предложения — при чтении, правке, отправке и ответе; ссылка на
// предложение неизменна. Отвязка требования наследование не снимает. Вторая линия — миграция 0041: принятое
// предложение создаёт запись своего вида, которая несёт все его цитаты. Обновление с 0040 — на принятом вопросе,
// записанном прежним кодом. Сценарии независимого ревьюера — в reviewRegressions16.test.ts. Данные поддельные.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatEtag } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, loadAccessContext, migrate, MIGRATIONS_DIR, setupDatabase, stageVisibility } from '../packages/db/src/index.ts';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { ADMIN_URL, buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { buildMailScope, MARK, setMailAccess, type IMailScope } from './mailFixtures.ts';
import { callTool, issueToken, mcpClient, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SECRET = 'ПРОИСХОЖДЕНИЕ-16-70412';
const EDITED = 'ПРАВКА-16-55108';
const ANSWER = 'ОТВЕТ-16-90336';

interface IQuestionView {
  id: string;
  visible: boolean;
  text: string | null;
  answerNote: string | null;
  status: string;
  requirementId: string | null;
  sourceProposalId: string | null;
  rowVersion: number;
}

const questions = async (client: TestClient, stageId: string): Promise<IQuestionView[]> => {
  const r = await client.get(`/stages/${stageId}/customer-questions`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as IQuestionView[];
};
const questionOf = async (client: TestClient, stageId: string, id: string): Promise<IQuestionView> => (await questions(client, stageId)).find((q) => q.id === id)!;
const patchQuestion = async (client: TestClient, reader: TestClient, stageId: string, id: string, body: Record<string, unknown>) =>
  client.patch(`/customer-questions/${id}`, body, { headers: { 'If-Match': formatEtag(id, (await questionOf(reader, stageId, id)).rowVersion) } });
const sqlCode = async (db: ITestDb, sql: string, params: unknown[] = []): Promise<string | null> => {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

// Ящик А читают инженер 1 и руководитель; инженер 2 — участник тендера без права на ящик.
interface IChatStage {
  db: ITestDb;
  s: IScenario;
  mail: IMailScope;
  endpoint: IMcpEndpoint;
  mailFragment: string;
  docFragment: string;
  proposer: { id: string; token: string };
}

const buildChatStage = async (db: ITestDb): Promise<IChatStage> => {
  const config = testConfig();
  const app = makeApp(db, undefined, config);
  const s = await buildScenario(db, app);
  const runs = new Map<string, string>();
  const mail = await buildMailScope(
    s,
    makeWorker(db, config),
    () => uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ происхождение.pdf'),
    async (rev, text) => {
      const run = await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] });
      runs.set(rev, run);
      return run;
    },
  );
  await setWorkingSet(s.eng1, s.stageA, [mail.tenderDoc, mail.attRevision], true);
  await fixScope(s.eng1, s.stageA);
  const mailFragment = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [mail.m1Revision])).rows[0]!.id;
  const docFragment = await fragmentIdOf(db.pool, runs.get(mail.tenderDoc)!, MARK.tenderDoc);
  return { db, s, mail, endpoint: await startMcp(app), mailFragment, docFragment, proposer: await issueToken(s.eng1, { propose: true }) };
};

const proposeVia = async (st: IChatStage, tool: string, args: Record<string, unknown>): Promise<string> => {
  const c = await mcpClient(st.endpoint.url, st.proposer.token);
  try {
    const r = await callTool(c, tool, { tenderId: st.s.tenderA, stageId: st.s.stageA, ...args });
    expect(r.isError, r.text).toBe(false);
    return r.body.proposal.id as string;
  } finally {
    await c.close();
  }
};
const proposalEtag = async (st: IChatStage, id: string): Promise<string> =>
  ((await st.s.manager.get(`/stages/${st.s.stageA}/mcp-proposals`)).body.items as { id: string; etag: string }[]).find((p) => p.id === id)!.etag;
const accept = async (st: IChatStage, id: string, body: Record<string, unknown> = {}, headers = idem()) =>
  st.s.manager.post(`/mcp-proposals/${id}/accept`, body, { headers: { ...headers, 'If-Match': await proposalEtag(st, id) } });

describe('R16-01: вопрос из предложения чата наследует закрытость цитат', () => {
  let st: IChatStage;
  let privateProposal: string;
  let privateQuestion: string;

  beforeAll(async () => {
    st = await buildChatStage(await createTestDb());
    privateProposal = await proposeVia(st, 'propose_question', { text: `Подтвердите условие ${SECRET}`, citedFragmentIds: [st.mailFragment], requestId: 'origin-private-question-01' });
  });
  afterAll(async () => {
    await st?.endpoint.close();
    await st?.db.drop();
  });

  it('принятие создаёт один вопрос со ссылкой на предложение; повтор по ключу второго вопроса не создаёт', async () => {
    const key = idem();
    const etag = await proposalEtag(st, privateProposal);
    const first = await st.s.manager.post(`/mcp-proposals/${privateProposal}/accept`, {}, { headers: { ...key, 'If-Match': etag } });
    expect(first.status, first.text).toBe(200);
    expect(first.body.result.type).toBe('customer_question');
    privateQuestion = first.body.result.id as string;
    const again = await st.s.manager.post(`/mcp-proposals/${privateProposal}/accept`, {}, { headers: { ...key, 'If-Match': etag } });
    expect(again.status, again.text).toBe(200);
    expect(again.body.result).toEqual(first.body.result);
    const rows = await st.db.pool.query<{ id: string; source_proposal_id: string }>('SELECT id, source_proposal_id FROM customer_question WHERE source_proposal_id = $1', [privateProposal]);
    expect(rows.rows).toEqual([{ id: privateQuestion, source_proposal_id: privateProposal }]);
  });

  it('тому, кто письмо не читает, вопрос закрыт: происхождение видно, текста нет; читающим — как раньше', async () => {
    expect(await questionOf(st.s.eng2, st.s.stageA, privateQuestion)).toMatchObject({ visible: false, text: null, answerNote: null, sourceProposalId: privateProposal });
    for (const reader of [st.s.eng1, st.s.manager]) {
      expect(await questionOf(reader, st.s.stageA, privateQuestion)).toMatchObject({ visible: true, text: `Подтвердите условие ${SECRET}`, sourceProposalId: privateProposal });
    }
    // Та же функция закрывает вопрос в карточке комплекта, сравнении выпусков и основаниях замечаний.
    const visible = async (userId: string) => (await stageVisibility(st.db.pool, (await loadAccessContext(st.db.pool, userId, 'test'))!, st.s.stageA)).visible('question', privateQuestion);
    expect(await visible(st.s.ids.eng2)).toBe(false);
    expect(await visible(st.s.ids.manager)).toBe(true);
  });

  it('закрытый вопрос нельзя изменить и отметить отправленным, не читая его основания', async () => {
    for (const body of [{ text: 'Подмена текста' }, { status: 'sent' }, { status: 'closed' }, { requirementId: null }]) {
      const r = await patchQuestion(st.s.eng2, st.s.manager, st.s.stageA, privateQuestion, body);
      expect(r.status, r.text).toBe(409);
      expect(r.body.current).toMatchObject({ reason: 'restricted_fragments', object: 'question' });
      expect(r.text).not.toContain(SECRET);
    }
    expect(await questionOf(st.s.manager, st.s.stageA, privateQuestion)).toMatchObject({ status: 'draft', rowVersion: 1, text: `Подтвердите условие ${SECRET}` });
  });

  it('правка, отправка и ответ читающим вопрос не открывают; происхождение не меняется', async () => {
    const edited = await patchQuestion(st.s.eng1, st.s.manager, st.s.stageA, privateQuestion, { text: `Уточните условие ${EDITED}` });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body).toMatchObject({ visible: true, text: `Уточните условие ${EDITED}`, sourceProposalId: privateProposal });
    const sent = await patchQuestion(st.s.eng1, st.s.manager, st.s.stageA, privateQuestion, { status: 'sent' });
    expect(sent.status, sent.text).toBe(200);
    const answered = await patchQuestion(st.s.manager, st.s.manager, st.s.stageA, privateQuestion, { status: 'answered', answerNote: `Заказчик ответил: ${ANSWER}` });
    expect(answered.status, answered.text).toBe(200);
    const hidden = await st.s.eng2.get(`/stages/${st.s.stageA}/customer-questions`);
    for (const secret of [SECRET, EDITED, ANSWER]) expect(hidden.text).not.toContain(secret);
    expect((hidden.body.items as IQuestionView[]).find((q) => q.id === privateQuestion)).toMatchObject({ visible: false, text: null, answerNote: null, status: 'answered', sourceProposalId: privateProposal });
    // Тот же вопрос через чат-клиент пользователя без права на ящик.
    const blind = await issueToken(st.s.eng2);
    const c = await mcpClient(st.endpoint.url, blind.token);
    const listed = await callTool(c, 'list_questions', { tenderId: st.s.tenderA, stageId: st.s.stageA });
    await c.close();
    expect(listed.isError, listed.text).toBe(false);
    for (const secret of [SECRET, EDITED, ANSWER]) expect(listed.text).not.toContain(secret);
  });

  it('права считаются при чтении: получив доступ к ящику, пользователь видит вопрос; потеряв — снова нет', async () => {
    await setMailAccess(st.s.admin, st.mail.boxA, st.s.ids.eng2, ['mail.read']);
    try {
      expect(await questionOf(st.s.eng2, st.s.stageA, privateQuestion)).toMatchObject({ visible: true, text: `Уточните условие ${EDITED}`, answerNote: `Заказчик ответил: ${ANSWER}` });
    } finally {
      await setMailAccess(st.s.admin, st.mail.boxA, st.s.ids.eng2, ['mail.import']);
    }
    expect(await questionOf(st.s.eng2, st.s.stageA, privateQuestion)).toMatchObject({ visible: false, text: null, answerNote: null });
  });

  it('контроль: вопросы без закрытого основания читают и ведут все участники, как раньше', async () => {
    const noCitations = await proposeVia(st, 'propose_question', { text: 'Уточните срок поставки окон', requestId: 'origin-open-question-01' });
    const docCitation = await proposeVia(st, 'propose_question', { text: 'Подтвердите обмазочную гидроизоляцию', citedFragmentIds: [st.docFragment], requestId: 'origin-open-question-02' });
    for (const [proposalId, text] of [[noCitations, 'Уточните срок поставки окон'], [docCitation, 'Подтвердите обмазочную гидроизоляцию']] as const) {
      const r = await accept(st, proposalId);
      expect(r.status, r.text).toBe(200);
      expect(await questionOf(st.s.eng2, st.s.stageA, r.body.result.id as string)).toMatchObject({ visible: true, text, sourceProposalId: proposalId });
    }
    const plain = await st.s.eng2.post(`/stages/${st.s.stageA}/customer-questions`, { text: 'Обычный вопрос без основания' }, { headers: idem() });
    expect(plain.status, plain.text).toBe(201);
    expect(plain.body).toMatchObject({ visible: true, sourceProposalId: null });
    const sent = await patchQuestion(st.s.eng2, st.s.eng2, st.s.stageA, plain.body.id as string, { status: 'sent' });
    expect(sent.status, sent.text).toBe(200);
    expect(await questionOf(st.s.eng1, st.s.stageA, plain.body.id as string)).toMatchObject({ visible: true, text: 'Обычный вопрос без основания', status: 'sent' });
  });

  describe('вторая линия БД (миграция 0041)', () => {
    const insertQuestion = (origin: string | null) =>
      sqlCode(st.db, 'INSERT INTO customer_question (tender_id, stage_id, text, created_by, updated_by, source_proposal_id) VALUES ($1, $2, $3, $4, $4, $5)', [st.s.tenderA, st.s.stageA, 'прямая запись', st.s.ids.manager, origin]);
    const decide = (id: string, resultType: string | null, resultId: string | null) =>
      sqlCode(st.db, "UPDATE mcp_proposal SET status = 'accepted', decided_by = $2, decided_at = now(), result_type = $3, result_id = $4, row_version = row_version + 1 WHERE id = $1", [id, st.s.ids.manager, resultType, resultId]);

    it('происхождение вопроса неизменно', async () => {
      const other = await proposeVia(st, 'propose_question', { text: 'Другое предложение', requestId: 'origin-guard-question-01' });
      for (const value of [null, other]) {
        expect(await sqlCode(st.db, 'UPDATE customer_question SET source_proposal_id = $2, updated_by = $3, row_version = row_version + 1 WHERE id = $1', [privateQuestion, value, st.s.ids.manager])).toBe('55000');
      }
      const plain = (await st.db.pool.query<{ id: string }>('SELECT id FROM customer_question WHERE source_proposal_id IS NULL AND stage_id = $1 LIMIT 1', [st.s.stageA])).rows[0]!.id;
      expect(await sqlCode(st.db, 'UPDATE customer_question SET source_proposal_id = $2, updated_by = $3, row_version = row_version + 1 WHERE id = $1', [plain, other, st.s.ids.manager])).toBe('55000');
    });

    it('ссылка ставится только на открытое предложение-вопрос этого этапа и только вместе с его принятием', async () => {
      const finding = await proposeVia(st, 'propose_finding', { title: 'Замечание для охранника', body: 'Текст', citedFragmentIds: [st.docFragment], requestId: 'origin-guard-finding-01' });
      const open = await proposeVia(st, 'propose_question', { text: 'Открытое предложение', requestId: 'origin-guard-question-02' });
      // Уже принятое предложение и предложение другого вида.
      expect(await insertQuestion(privateProposal)).toBe('23514');
      expect(await insertQuestion(finding)).toBe('23514');
      // Открытое предложение-вопрос без принятия в той же транзакции — отказ при фиксации.
      expect(await insertQuestion(open)).toBe('23514');
      expect((await st.db.pool.query('SELECT 1 FROM customer_question WHERE source_proposal_id = $1', [open])).rowCount).toBe(0);
    });

    it('принятое предложение создаёт запись своего вида, и она несёт его цитаты', async () => {
      const question = await proposeVia(st, 'propose_question', { text: 'Вопрос для охранника', citedFragmentIds: [st.mailFragment], requestId: 'origin-guard-question-03' });
      const finding = await proposeVia(st, 'propose_finding', { title: 'Замечание по ТЗ', body: 'Текст', citedFragmentIds: [st.docFragment], requestId: 'origin-guard-finding-02' });
      const condition = await proposeVia(st, 'propose_condition_text', { text: 'Текст условия', requestId: 'origin-guard-condition-01' });
      const plain = (await st.db.pool.query<{ id: string }>('SELECT id FROM customer_question WHERE source_proposal_id IS NULL AND stage_id = $1 LIMIT 1', [st.s.stageA])).rows[0]!.id;
      // Вопрос без ссылки на предложение, без записи вовсе и запись другого вида.
      expect(await decide(question, 'customer_question', plain)).toBe('23514');
      expect(await decide(question, null, null)).toBe('23514');
      expect(await decide(question, 'finding', plain)).toBe('23514');
      // Замечание, среди оснований которого нет цитаты предложения.
      const mailFinding = await proposeVia(st, 'propose_finding', { title: 'Замечание по письму', body: 'Текст', citedFragmentIds: [st.mailFragment], requestId: 'origin-guard-finding-03' });
      const accepted = await accept(st, mailFinding, { severity: 'minor', confidence: 'low' });
      expect(accepted.status, accepted.text).toBe(200);
      expect(await decide(finding, 'finding', accepted.body.result.id as string)).toBe('23514');
      // Текст условия записи не создаёт.
      expect(await decide(condition, 'customer_question', plain)).toBe('23514');
      expect(await decide(condition, null, null)).toBeNull();
      const statuses = await st.db.pool.query<{ id: string; status: string }>('SELECT id, status FROM mcp_proposal WHERE id = ANY($1::uuid[])', [[question, finding]]);
      expect(statuses.rows.map((r) => r.status)).toEqual(['open', 'open']);
    });
  });
});

describe('S16-12: отвязка требования не снимает наследование закрытости вопроса', () => {
  const HIDDEN = 'ДОГОВОР-16-33907';
  let db: ITestDb;
  let st: IStage08;
  let closedRequirement: string;
  let openRequirement: string;

  beforeAll(async () => {
    db = await createTestDb();
    const config = testConfig();
    st = await buildStage08(db, config);
    const { s } = st;
    // Договор читает только руководитель; инженер 1 — участник тендера без доступа к договору.
    await grantCreator(s.admin, s.ids.manager);
    const contract = await createContract(s.manager, 'Д-16-S12');
    await setAccess(s.admin, contract, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    const rev = (await uploadMain(s.manager, contract)).revisionId;
    const clause = `Особое условие договора: шифр ${HIDDEN}`;
    const contractFragment = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [clause] }] }), clause);
    await linkContract(s.manager, contract, s.tenderA);
    await setWorkingSet(s.manager, s.stageA, [st.docRev, rev], true);
    const scope = await fixScope(s.manager, s.stageA);
    const registry = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'ТЗ и договор' }, { headers: idem() });
    expect(registry.status, registry.text).toBe(201);
    const requirement = async (statement: string, evidence: object[]): Promise<string> => {
      const r = await confirm(s.manager, (await propose(s.manager, registry.body.id as string, statement, evidence)).id);
      expect(r.status, r.text).toBe(200);
      return r.body.requirementId as string;
    };
    closedRequirement = await requirement(`Колонны — бетон по шифру ${HIDDEN}`, [...supports(st.frag.facade), { fragmentId: contractFragment, role: 'clarifies' }]);
    openRequirement = await requirement('Кровля плоская с внутренним водостоком', supports(st.frag.roof));
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('вопрос остаётся закрытым после отвязки и замены требования; история связей не сбрасывается', async () => {
    const { s } = st;
    const created = await s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: `Подтвердите шифр ${HIDDEN}`, requirementId: closedRequirement }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: false, text: null });

    const unlinked = await patchQuestion(s.manager, s.manager, s.stageA, id, { requirementId: null });
    expect(unlinked.status, unlinked.text).toBe(200);
    expect(unlinked.body).toMatchObject({ requirementId: null, visible: true });
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: false, text: null, requirementId: null });

    const relinked = await patchQuestion(s.manager, s.manager, s.stageA, id, { requirementId: openRequirement });
    expect(relinked.status, relinked.text).toBe(200);
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: false, text: null, requirementId: openRequirement });
    expect((await s.eng1.get(`/stages/${s.stageA}/customer-questions`)).text).not.toContain(HIDDEN);

    // Историю связей ведёт охранник: значение, присланное клиентом, не учитывается.
    expect(await sqlCode(db, "UPDATE customer_question SET basis_requirement_ids = '{}', updated_by = $2, row_version = row_version + 1 WHERE id = $1", [id, s.ids.manager])).toBeNull();
    const basis = (await db.pool.query<{ ids: string[] }>('SELECT basis_requirement_ids AS ids FROM customer_question WHERE id = $1', [id])).rows[0]!.ids;
    expect([...basis].sort()).toEqual([closedRequirement, openRequirement].sort());
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: false, text: null });
  });

  it('контроль: вопрос по открытому требованию виден участникам до и после отвязки', async () => {
    const { s } = st;
    const created = await s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: 'Уточните уклон кровли', requirementId: openRequirement }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: true, text: 'Уточните уклон кровли' });
    expect((await patchQuestion(s.eng1, s.eng1, s.stageA, id, { requirementId: null })).status).toBe(200);
    expect(await questionOf(s.eng1, s.stageA, id)).toMatchObject({ visible: true, text: 'Уточните уклон кровли', requirementId: null });
  });
});

describe('обновление схемы 0040 → последняя миграция', () => {
  const LATEST = Math.max(...readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))));

  it('вопрос, созданный принятием предложения прежним кодом, получает происхождение и закрывается', async () => {
    const name = `kontur_kp_test_upgrade40_${Date.now().toString(36)}`;
    const urlFor = (user: string): string => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig40-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await mc.connect();
      try {
        return (await migrate(mc, { testMode: true, dir })).length;
      } finally {
        await mc.end();
      }
    };
    await setupDatabase(ADMIN_URL, name);
    const up: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    let st: IChatStage | undefined;
    try {
      expect(await migrateTo(40)).toBe(40);
      st = await buildChatStage(up);
      const { s } = st;
      const closed = await proposeVia(st, 'propose_question', { text: `Подтвердите условие ${SECRET}`, citedFragmentIds: [st.mailFragment], requestId: 'upgrade-private-question-01' });
      const open = await proposeVia(st, 'propose_question', { text: 'Уточните срок поставки окон', requestId: 'upgrade-open-question-01' });
      // Принятие в форме передачи 16-1: вопрос — копия текста без ссылки на предложение (колонки ещё нет).
      const acceptLegacy = async (proposalId: string, text: string): Promise<string> => {
        const c = await up.pool.connect();
        try {
          await c.query('BEGIN');
          const id = (await c.query<{ id: string }>('INSERT INTO customer_question (tender_id, stage_id, text, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id', [s.tenderA, s.stageA, text, s.ids.manager])).rows[0]!.id;
          await c.query("UPDATE mcp_proposal SET status = 'accepted', decided_by = $2, decided_at = now(), result_type = 'customer_question', result_id = $3, row_version = row_version + 1 WHERE id = $1", [proposalId, s.ids.manager, id]);
          await c.query('COMMIT');
          return id;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      };
      const closedQuestion = await acceptLegacy(closed, `Подтвердите условие ${SECRET}`);
      const openQuestion = await acceptLegacy(open, 'Уточните срок поставки окон');
      const plain = (await up.pool.query<{ id: string }>("INSERT INTO customer_question (tender_id, stage_id, text, created_by, updated_by) VALUES ($1, $2, 'Обычный вопрос', $3, $3) RETURNING id", [s.tenderA, s.stageA, s.ids.eng1])).rows[0]!.id;

      expect(await migrateTo(LATEST)).toBe(LATEST - 40);

      const rows = await up.pool.query<{ id: string; source_proposal_id: string | null; row_version: string }>('SELECT id, source_proposal_id, row_version FROM customer_question WHERE stage_id = $1', [s.stageA]);
      const origin = new Map(rows.rows.map((r) => [r.id, r.source_proposal_id]));
      expect([origin.get(closedQuestion), origin.get(openQuestion), origin.get(plain)]).toEqual([closed, open, null]);
      // Заполнение версию строк не меняет: содержимое вопросов прежнее.
      expect(rows.rows.map((r) => Number(r.row_version))).toEqual([1, 1, 1]);
      expect((await up.pool.query('SELECT 1 FROM customer_question WHERE requirement_id IS NOT NULL AND NOT requirement_id = ANY (basis_requirement_ids)')).rowCount).toBe(0);

      expect(await questionOf(s.eng2, s.stageA, closedQuestion)).toMatchObject({ visible: false, text: null, sourceProposalId: closed });
      expect((await s.eng2.get(`/stages/${s.stageA}/customer-questions`)).text).not.toContain(SECRET);
      expect(await questionOf(s.eng1, s.stageA, closedQuestion)).toMatchObject({ visible: true, text: `Подтвердите условие ${SECRET}` });
      expect(await questionOf(s.eng2, s.stageA, openQuestion)).toMatchObject({ visible: true, text: 'Уточните срок поставки окон', sourceProposalId: open });
      expect(await questionOf(s.eng2, s.stageA, plain)).toMatchObject({ visible: true, text: 'Обычный вопрос', sourceProposalId: null });

      // После обновления принятие идёт новым путём, охранники 0041 действуют.
      const next = await proposeVia(st, 'propose_question', { text: `Ещё вопрос ${SECRET}`, citedFragmentIds: [st.mailFragment], requestId: 'upgrade-private-question-02' });
      const accepted = await accept(st, next);
      expect(accepted.status, accepted.text).toBe(200);
      expect(await questionOf(s.eng2, s.stageA, accepted.body.result.id as string)).toMatchObject({ visible: false, text: null, sourceProposalId: next });
      expect(await sqlCode(up, 'UPDATE customer_question SET source_proposal_id = NULL, updated_by = $2, row_version = row_version + 1 WHERE id = $1', [closedQuestion, s.ids.manager])).toBe('55000');
    } finally {
      await st?.endpoint.close();
      await up.pool.end().catch(() => undefined);
      await dropDatabase(ADMIN_URL, name);
    }
  });
});
