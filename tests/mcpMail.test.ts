// Этап 16 (проект §4, §6, §12; RT-02 через MCP): письмо из закрытого для пользователя ящика не участвует в поиске,
// цитатах и предложениях чат-клиента; отзыв `mail.read` после создания прогона — `scope_changed`; предложение с цитатой
// из письма закрыто тому, кто письмо не читает, и решить по нему он не может. Письма — синтетические EML.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildMailScope, MARK, setMailAccess, type IMailScope } from './mailFixtures.ts';
import { callTool, issueToken, mcpClient, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { buildIndex, fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let m: IMailScope;
let mcp: IMcpEndpoint;
let reader: { id: string; token: string };
let proposer: { id: string; token: string };
let noMail: { id: string; token: string };
let letterFragment: string;
let boxA: string;
const config = testConfig();
const scope = () => ({ tenderId: s.tenderA, stageId: s.stageA });

const search = async (token: string, query: string) => {
  const client = await mcpClient(mcp.url, token);
  try {
    const started = await callTool(client, 'search_evidence', { ...scope(), query });
    expect(started.isError, started.text).toBe(false);
    await drain(worker);
    const done = await callTool(client, 'get_search_run', { searchRunId: started.body.searchRunId });
    return { started: started.body, done };
  } finally {
    await client.close();
  }
};

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  m = await buildMailScope(
    s,
    worker,
    () => uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf'),
    (rev, text) => seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] }),
  );
  await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc, m.attRevision], true);
  await fixScope(s.eng1, s.stageA);
  await buildIndex(db, worker);
  letterFragment = (await db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [m.m1Revision])).rows[0]!.id;
  boxA = (await db.pool.query<{ mailbox_id: string }>('SELECT mailbox_id FROM mail_message WHERE id = $1', [m.m1])).rows[0]!.mailbox_id;
  mcp = await startMcp(app);
  reader = await issueToken(s.eng1);
  proposer = await issueToken(s.eng1, { propose: true, name: 'предложения' });
  noMail = await issueToken(s.eng2, { propose: true });
}, 300_000);
afterAll(async () => {
  await mcp?.close();
  await db?.drop();
});

describe('RT-02 через MCP: письмо из закрытого ящика', () => {
  it('с mail.read письмо находится и цитируется; без mail.read — исключено до ранжирования, видно только числом', async () => {
    const mine = await search(reader.token, 'ЖЕЛЕЗОБЕТОН-7741 гидроизоляция');
    expect(mine.done.isError, mine.done.text).toBe(false);
    expect(mine.done.body.fragments.some((f: any) => f.fragmentId === letterFragment)).toBe(true);
    const theirs = await search(noMail.token, 'ЖЕЛЕЗОБЕТОН-7741 гидроизоляция');
    expect(theirs.done.isError, theirs.done.text).toBe(false);
    expect(theirs.done.body.fragments.map((f: any) => f.fragmentId)).not.toContain(letterFragment);
    expect(theirs.done.text).not.toContain('ЖЕЛЕЗОБЕТОН-7741');
    expect(theirs.done.text).not.toContain(MARK.att);
    expect(theirs.done.body.scope.excludedByAcl).toBeGreaterThan(0);
    const client = await mcpClient(mcp.url, noMail.token);
    expect((await callTool(client, 'get_citation', { fragmentId: letterFragment })).body.error).toEqual({ code: 'out_of_scope', message: 'объект вне области запроса или недоступен' });
    // В составе этапа вложение письма для него — закрытая единица без названия.
    const docs = await callTool(client, 'list_documents', scope());
    const attachment = docs.body.documents.find((d: any) => d.source === 'mail_attachment');
    expect(attachment).toMatchObject({ restricted: true, title: null });
    await client.close();
  });

  it('отзыв mail.read после создания прогона: get_search_run — scope_changed, результат не отдаётся', async () => {
    const client = await mcpClient(mcp.url, reader.token);
    const started = await callTool(client, 'search_evidence', { ...scope(), query: 'ЖЕЛЕЗОБЕТОН-7741' });
    await drain(worker);
    await setMailAccess(s.admin, boxA, s.ids.eng1, ['mail.import', 'mail.link']);
    try {
      const after = await callTool(client, 'get_search_run', { searchRunId: started.body.searchRunId });
      expect(after.isError).toBe(true);
      expect(after.body.error).toMatchObject({ code: 'scope_changed' });
      expect(after.text).not.toContain('ЖЕЛЕЗОБЕТОН-7741');
      expect((await callTool(client, 'get_citation', { fragmentId: letterFragment })).body.error).toMatchObject({ code: 'out_of_scope' });
    } finally {
      await setMailAccess(s.admin, boxA, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    }
    expect((await callTool(client, 'get_search_run', { searchRunId: started.body.searchRunId })).isError).toBe(false);
    await client.close();
  });
});

describe('предложение с цитатой из письма', () => {
  it('без mail.read цитировать письмо нельзя; предложение читающего закрыто для нечитающего, и решить по нему он не может', async () => {
    const blind = await mcpClient(mcp.url, noMail.token);
    const refused = await callTool(blind, 'propose_finding', { ...scope(), title: 'По письму заказчика', body: 'Гидроизоляция согласована письмом.', citedFragmentIds: [letterFragment], requestId: 'req-mail-blind-0001' });
    expect(refused.body.error).toMatchObject({ code: 'invalid_citation' });
    expect(refused.text).not.toContain('ЖЕЛЕЗОБЕТОН');
    await blind.close();

    const client = await mcpClient(mcp.url, proposer.token);
    const made = await callTool(client, 'propose_finding', { ...scope(), title: 'ЗАКРЫТЫЙ-ЗАГОЛОВОК-16 по письму', body: 'ЗАКРЫТЫЙ-ТЕКСТ-16: гидроизоляция согласована письмом заказчика.', citedFragmentIds: [letterFragment], requestId: 'req-mail-open-0001' });
    expect(made.isError, made.text).toBe(false);
    await client.close();
    const id = made.body.proposal.id as string;

    // Инженер 2 — участник тендера без права читать ящик: предложение видит, текст — нет.
    const hidden = (await s.eng2.get(`/stages/${s.stageA}/mcp-proposals`)).body.items.find((p: any) => p.id === id);
    expect(hidden).toMatchObject({ restricted: true, title: null, body: null, citedFragmentIds: [], citations: 1, can: { decide: false } });
    expect(JSON.stringify(hidden)).not.toContain('ЗАКРЫТЫЙ');
    for (const action of ['accept', 'reject']) {
      const r = await s.eng2.post(`/mcp-proposals/${id}/${action}`, action === 'accept' ? { severity: 'minor', confidence: 'low' } : { reason: 'не вижу оснований' }, { headers: { 'If-Match': hidden.etag, ...idem() } });
      expect(r.status, action).toBe(409);
      expect(r.body.current).toMatchObject({ reason: 'restricted_fragments' });
      expect(JSON.stringify(r.body)).not.toContain('ЗАКРЫТЫЙ');
    }
    // Руководитель читает ящик: видит текст и принимает.
    const open = (await s.manager.get(`/stages/${s.stageA}/mcp-proposals`)).body.items.find((p: any) => p.id === id);
    expect(open).toMatchObject({ restricted: false, title: 'ЗАКРЫТЫЙ-ЗАГОЛОВОК-16 по письму', can: { decide: true } });
    const accepted = await s.manager.post(`/mcp-proposals/${id}/accept`, { severity: 'major', confidence: 'medium' }, { headers: { 'If-Match': open.etag, ...idem() } });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.result).toMatchObject({ type: 'finding' });
    // Принятое предложение остаётся закрытым для того, кто письмо не читает; замечание — тоже (правила этапа 09).
    const still = (await s.eng2.get(`/stages/${s.stageA}/mcp-proposals`)).body.items.find((p: any) => p.id === id);
    expect(still).toMatchObject({ status: 'accepted', restricted: true, body: null });
    const viaMcp = await mcpClient(mcp.url, noMail.token);
    const findings = await callTool(viaMcp, 'list_findings', scope());
    expect(findings.text).not.toContain('ЗАКРЫТЫЙ');
    await viaMcp.close();
  });
});
