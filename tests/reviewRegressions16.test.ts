// Регрессии Review 16-1 (docs/reviews/16-review-1.md). Сценарии независимого ревьюера — из `reviewer16.test.ts` архива
// ревью; названия и ожидания не менялись, убрана только запись наблюдений в файл.
// R16-01: вопрос заказчику, созданный принятием предложения из чата, наследует ограничения чтения цитат предложения —
// принятие человеком не снимает права на источник. Четыре контроля ревьюера сохранены с теми же ожиданиями.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildMailScope, setMailAccess, type IMailScope } from './mailFixtures.ts';
import { callTool, issueToken, mcpClient, rawPost, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SECRET = 'REVIEW-16-MAIL-PRIVATE-66231';

interface IProposalView {
  id: string;
  etag: string;
  restricted: boolean;
  body: string | null;
  citedFragmentIds: string[];
}

describe('Review 16-1: сценарии независимого ревьюера', () => {
  let db: ITestDb;
  let s: IScenario;
  let mail: IMailScope;
  let endpoint: IMcpEndpoint;
  let fragment: string;
  let proposer: { id: string; token: string };
  let blind: { id: string; token: string };
  let questionProposal: string;
  let questionId: string;
  let findingProposal: string;

  const scope = () => ({ tenderId: s.tenderA, stageId: s.stageA });
  const invoke = async (token: string, name: string, args: Record<string, unknown>) => {
    const c = await mcpClient(endpoint.url, token);
    try {
      return await callTool(c, name, args);
    } finally {
      await c.close();
    }
  };
  const proposal = async (id: string, who = s.manager): Promise<IProposalView> =>
    ((await who.get(`/stages/${s.stageA}/mcp-proposals`)).body.items as IProposalView[]).find((p) => p.id === id)!;

  beforeAll(async () => {
    db = await createTestDb();
    const config = testConfig();
    const app = makeApp(db, undefined, config);
    s = await buildScenario(db, app);
    const worker = makeWorker(db, config);
    mail = await buildMailScope(
      s,
      worker,
      () => uploadDocument(db, config, s.eng1, s.stageA, 'Independent TZ.pdf'),
      (rev, text) => seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] }),
    );
    await setWorkingSet(s.eng1, s.stageA, [mail.tenderDoc, mail.attRevision], true);
    await fixScope(s.eng1, s.stageA);
    fragment = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [mail.m1Revision])).rows[0]!.id;
    endpoint = await startMcp(app);
    proposer = await issueToken(s.eng1, { propose: true });
    blind = await issueToken(s.eng2, { propose: true });
    const q = await invoke(proposer.token, 'propose_question', { ...scope(), text: `Подтвердите закрытое условие ${SECRET}`, citedFragmentIds: [fragment], requestId: 'review16-private-question-0001' });
    expect(q.isError, q.text).toBe(false);
    questionProposal = q.body.proposal.id;
    const f = await invoke(proposer.token, 'propose_finding', {
      ...scope(),
      title: `Замечание ${SECRET}`,
      body: `По письму ${SECRET}`,
      citedFragmentIds: [fragment],
      requestId: 'review16-private-finding-0001',
    });
    expect(f.isError, f.text).toBe(false);
    findingProposal = f.body.proposal.id;
  });

  afterAll(async () => {
    await endpoint?.close();
    await db?.drop();
  });

  it('control: unreadable proposal and citation do not expose the private mail-derived text', async () => {
    const p = await proposal(questionProposal, s.eng2);
    expect(p).toMatchObject({ restricted: true, body: null, citedFragmentIds: [] });
    expect(JSON.stringify(p)).not.toContain(SECRET);
    const citation = await invoke(blind.token, 'get_citation', { fragmentId: fragment });
    expect(citation.body.error.code).toBe('out_of_scope');
  });

  it('control: repeating an MCP proposal does not create a duplicate', async () => {
    const count = Number((await db.pool.query('SELECT count(*) AS n FROM mcp_proposal')).rows[0].n);
    const again = await invoke(proposer.token, 'propose_finding', {
      ...scope(),
      title: `Замечание ${SECRET}`,
      body: `По письму ${SECRET}`,
      citedFragmentIds: [fragment],
      requestId: 'review16-private-finding-0001',
    });
    expect(again.body.proposal).toMatchObject({ id: findingProposal, repeat: true });
    expect(Number((await db.pool.query('SELECT count(*) AS n FROM mcp_proposal')).rows[0].n)).toBe(count);
  });

  it('control: an accepted finding retains privacy inherited from its cited mail', async () => {
    const p = await proposal(findingProposal);
    const accepted = await s.manager.post(`/mcp-proposals/${findingProposal}/accept`, { severity: 'major', confidence: 'high' }, { headers: { ...idem(), 'If-Match': p.etag } });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.result.type).toBe('finding');
    const hidden = await s.eng2.get(`/findings/${accepted.body.result.id}`);
    expect(hidden.status, hidden.text).toBe(200);
    expect(JSON.stringify(hidden.body)).not.toContain(SECRET);
  });

  it('an accepted question retains the privacy of its original cited mail through the portal API', async () => {
    const p = await proposal(questionProposal);
    const accepted = await s.manager.post(`/mcp-proposals/${questionProposal}/accept`, {}, { headers: { ...idem(), 'If-Match': p.etag } });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.result.type).toBe('customer_question');
    questionId = accepted.body.result.id;
    const hiddenProposal = await proposal(questionProposal, s.eng2);
    const questions = await s.eng2.get(`/stages/${s.stageA}/customer-questions`);
    expect(hiddenProposal).toMatchObject({ restricted: true, body: null });
    expect(questions.status, questions.text).toBe(200);
    expect(JSON.stringify(questions.body)).not.toContain(SECRET);
  });

  it('an accepted private question is also hidden from the MCP list_questions tool', async () => {
    expect(questionId, 'accepted question fixture').toBeTruthy();
    const r = await invoke(blind.token, 'list_questions', scope());
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain(SECRET);
  });

  it('after revoking the proposer mail access, its accepted question does not disclose the inherited text', async () => {
    await setMailAccess(s.admin, mail.boxA, s.ids.eng1, ['mail.import', 'mail.link']);
    try {
      const r = await s.eng1.get(`/stages/${s.stageA}/customer-questions`);
      expect(r.status, r.text).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
    } finally {
      await setMailAccess(s.admin, mail.boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    }
  });

  it('control: revoking a token after connecting rejects the next HTTP request', async () => {
    const token = await issueToken(s.eng1, { name: 'Independent revoked token' });
    const removed = await s.eng1.delete(`/api-tokens/${token.id}`);
    expect(removed.status, removed.text).toBe(200);
    const r = await rawPost(endpoint.url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { Authorization: `Bearer ${token.token}` });
    expect(r.status).toBe(401);
  });
});
