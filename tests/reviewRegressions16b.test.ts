// Регрессии Review 16-2 (docs/reviews/16-review-2.md). Сценарии независимого ревьюера — из `reviewer16b.test.ts` и
// `reviewer16Legacy.test.ts` архива ревью; названия и ожидания приватности не менялись, убрана запись наблюдений в файл.
// R16-02: вопрос, созданный по закрытому требованию и отвязанный от него прежней версией, после обновления остаётся
// закрытым. В архиве ревью прежние данные пишет настоящий код 054cff4 из соседней копии; здесь — те же команды API на
// схеме 0040 (legacyQuestionFixtures.ts), число применённых миграций сверяется с последней, а не с единицей.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatEtag } from '../packages/core/src/index.ts';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { buildLegacyStage, LATEST_MIGRATION, legacyPatch, legacyQuestion } from './legacyQuestionFixtures.ts';
import { buildMailScope, MARK, type IMailScope } from './mailFixtures.ts';
import { callTool, issueToken, mcpClient, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { confirm, propose, supports } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

interface IQuestionView {
  id: string;
  rowVersion: number;
}

describe('Review 16-2: дополнительные сценарии независимого ревьюера', () => {
  const SECRET = 'REVIEW-16-2-INHERITED-MAIL-18047';
  let db: ITestDb;
  let s: IScenario;
  let mail: IMailScope;
  let endpoint: IMcpEndpoint;
  let origin: string;
  let chatQuestion: string;
  let privateRequirement: string;
  let publicRequirement: string;
  let detachedQuestion: string;
  let fragment: string;
  let token: { id: string; token: string };

  const view = async (id: string, who: TestClient = s.manager) => {
    const r = await who.get(`/stages/${s.stageA}/customer-questions`);
    expect(r.status, r.text).toBe(200);
    return (r.body.items as IQuestionView[]).find((q) => q.id === id)!;
  };
  const patch = async (id: string, body: Record<string, unknown>, who: TestClient = s.manager) =>
    who.patch(`/customer-questions/${id}`, body, { headers: { 'If-Match': formatEtag(id, (await view(id)).rowVersion) } });
  const sqlCode = async (sql: string, params: unknown[]): Promise<string | null> => {
    try {
      await db.pool.query(sql, params);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
  };

  beforeAll(async () => {
    db = await createTestDb();
    const config = testConfig();
    const app = makeApp(db, undefined, config);
    s = await buildScenario(db, app);
    const runs = new Map<string, string>();
    mail = await buildMailScope(
      s,
      makeWorker(db, config),
      () => uploadDocument(db, config, s.eng1, s.stageA, 'Independent-origin-TZ.pdf'),
      async (rev, text) => {
        const run = await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] });
        runs.set(rev, run);
        return run;
      },
    );
    await setWorkingSet(s.manager, s.stageA, [mail.tenderDoc, mail.attRevision], true);
    const scope = await fixScope(s.manager, s.stageA);
    fragment = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [mail.m1Revision])).rows[0]!.id;
    const docFragment = await fragmentIdOf(db.pool, runs.get(mail.tenderDoc)!, MARK.tenderDoc);
    const registry = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'Independent privacy review' }, { headers: idem() });
    expect(registry.status, registry.text).toBe(201);
    const req = async (statement: string, evidence: object[]): Promise<string> => {
      const r = await confirm(s.manager, (await propose(s.manager, registry.body.id as string, statement, evidence)).id);
      expect(r.status, r.text).toBe(200);
      return r.body.requirementId as string;
    };
    privateRequirement = await req(`Частное условие ${SECRET}`, [...supports(docFragment), { fragmentId: fragment, role: 'clarifies' }]);
    publicRequirement = await req('Открытое требование гидроизоляции', supports(docFragment));
    endpoint = await startMcp(app);
    token = await issueToken(s.eng1, { propose: true });
    const c = await mcpClient(endpoint.url, token.token);
    const p = await callTool(c, 'propose_question', { tenderId: s.tenderA, stageId: s.stageA, text: `Подтвердите ${SECRET}`, citedFragmentIds: [fragment], requestId: 'independent-origin-16-2-0001' });
    await c.close();
    expect(p.isError, p.text).toBe(false);
    origin = p.body.proposal.id;
    const etag = ((await s.manager.get(`/stages/${s.stageA}/mcp-proposals`)).body.items as { id: string; etag: string }[]).find((x) => x.id === origin)!.etag;
    const accepted = await s.manager.post(`/mcp-proposals/${origin}/accept`, {}, { headers: { ...idem(), 'If-Match': etag } });
    expect(accepted.status, accepted.text).toBe(200);
    chatQuestion = accepted.body.result.id;
  });
  afterAll(async () => {
    await endpoint?.close();
    await db?.drop();
  });

  it('R16-01: a blind participant cannot edit, send or close an accepted private question', async () => {
    for (const body of [{ text: 'Попытка замены' }, { status: 'sent' }, { status: 'closed' }]) {
      const r = await patch(chatQuestion, body, s.eng2);
      expect(r.status, r.text).toBe(409);
      expect(r.text).not.toContain(SECRET);
      expect(r.body.current.reason).toBe('restricted_fragments');
    }
    expect(await view(chatQuestion)).toMatchObject({ status: 'draft', rowVersion: 1, sourceProposalId: origin });
  });

  it('R16-01: direct SQL cannot remove the accepted proposal origin', async () => {
    const code = await sqlCode('UPDATE customer_question SET source_proposal_id=NULL, updated_by=$2,row_version=row_version+1 WHERE id=$1', [chatQuestion, s.ids.manager]);
    expect(code).toBe('55000');
    expect(await view(chatQuestion, s.eng2)).toMatchObject({ visible: false, text: null, sourceProposalId: origin });
  });

  it('R16-01: a new accepted proposal cannot point at an ordinary question without its provenance', async () => {
    const c = await mcpClient(endpoint.url, token.token);
    const p = await callTool(c, 'propose_question', { tenderId: s.tenderA, stageId: s.stageA, text: `Новый ${SECRET}`, citedFragmentIds: [fragment], requestId: 'independent-origin-16-2-0002' });
    await c.close();
    expect(p.isError, p.text).toBe(false);
    const ordinary = await s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: 'Обычный открытый вопрос' }, { headers: idem() });
    expect(ordinary.status, ordinary.text).toBe(201);
    const code = await sqlCode("UPDATE mcp_proposal SET status='accepted',decided_by=$2,decided_at=now(),result_type='customer_question',result_id=$3,row_version=row_version+1 WHERE id=$1", [
      p.body.proposal.id,
      s.ids.manager,
      ordinary.body.id,
    ]);
    expect(code).toBe('23514');
  });

  it('S16-12: unlinking and relinking a private requirement cannot publish the question through API or MCP', async () => {
    const created = await s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: `Скопировано ${SECRET}`, requirementId: privateRequirement }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    detachedQuestion = created.body.id;
    expect(await view(detachedQuestion, s.eng2)).toMatchObject({ visible: false, text: null });
    expect((await patch(detachedQuestion, { requirementId: null })).status).toBe(200);
    const unlinked = await view(detachedQuestion, s.eng2);
    expect(unlinked).toMatchObject({ visible: false, text: null, requirementId: null });
    expect((await patch(detachedQuestion, { requirementId: publicRequirement })).status).toBe(200);
    const relinked = await view(detachedQuestion, s.eng2);
    expect(relinked).toMatchObject({ visible: false, text: null, requirementId: publicRequirement });
    const blocked = await patch(detachedQuestion, { status: 'sent' }, s.eng2);
    expect(blocked.status, blocked.text).toBe(409);
    const blind = await issueToken(s.eng2);
    const c = await mcpClient(endpoint.url, blind.token);
    const listed = await callTool(c, 'list_questions', { tenderId: s.tenderA, stageId: s.stageA });
    await c.close();
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).not.toContain(SECRET);
  });

  it('S16-12: direct SQL cannot erase the accumulated requirement basis', async () => {
    expect(await sqlCode("UPDATE customer_question SET basis_requirement_ids='{}',updated_by=$2,row_version=row_version+1 WHERE id=$1", [detachedQuestion, s.ids.manager])).toBeNull();
    const basis = (await db.pool.query<{ basis_requirement_ids: string[] }>('SELECT basis_requirement_ids FROM customer_question WHERE id=$1', [detachedQuestion])).rows[0]!.basis_requirement_ids;
    expect([...basis].sort()).toEqual([privateRequirement, publicRequirement].sort());
    expect(await view(detachedQuestion, s.eng2)).toMatchObject({ visible: false, text: null });
  });

  it('control: unlinking an open requirement preserves ordinary reading and sending', async () => {
    const created = await s.eng2.post(`/stages/${s.stageA}/customer-questions`, { text: 'Открытый контрольный вопрос', requirementId: publicRequirement }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    expect((await patch(id, { requirementId: null }, s.eng2)).status).toBe(200);
    expect((await patch(id, { status: 'sent' }, s.eng2)).status).toBe(200);
    expect(await view(id, s.eng1)).toMatchObject({ visible: true, text: 'Открытый контрольный вопрос', status: 'sent', requirementId: null });
  });
});

describe('Review 16-2: обновление базы прежней версии', () => {
  it('upgrade preserves privacy of a requirement-derived question detached by the previous version', async () => {
    const secret = 'REVIEW-16-2-LEGACY-PRIVATE-45328';
    const legacy = await buildLegacyStage('r1602', secret);
    try {
      const { s } = legacy.st;
      const id = await legacyQuestion(s.manager, s.stageA, { text: `Подтвердите ${secret}`, requirementId: legacy.closedRequirement });
      const before = await s.eng1.get(`/stages/${s.stageA}/customer-questions`);
      expect(before.text).not.toContain(secret);
      const detached = await legacyPatch(legacy.db, s.manager, id, { requirementId: null });
      expect(detached.status, detached.text).toBe(200);
      expect(await legacy.upgrade()).toBe(LATEST_MIGRATION - 40);

      const response = await s.eng1.get(`/stages/${s.stageA}/customer-questions`);
      const question = (response.body.items as IQuestionView[] | undefined)?.find((q) => q.id === id);
      const sent = await s.eng1.patch(`/customer-questions/${id}`, { status: 'sent' }, { headers: { 'If-Match': formatEtag(id, question!.rowVersion) } });
      const stillClosedRequirement = await s.eng1.get(`/requirements/${legacy.closedRequirement}`);
      expect(stillClosedRequirement.status, stillClosedRequirement.text).toBe(200);
      expect(stillClosedRequirement.text).not.toContain(secret);
      expect(response.status, response.text).toBe(200);
      expect(response.text).not.toContain(secret);
      // Требование ревью сверх двух утверждений сценария: без права на прежнее основание вопрос нельзя отметить отправленным.
      expect(sent.status, sent.text).toBe(409);
      expect(sent.text).not.toContain(secret);
    } finally {
      await legacy.close();
    }
  });
});
