// Этап 16 (проект §5.2, §6, §12): предложения чат-клиента. Запись от модели не становится решением (I12, A25); повтор
// запроса не дублирует запись (A37); цитата должна существовать и относиться к области. Данные поддельные.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { auditRows, buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { callTool, issueToken, mcpClient, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { buildIndex, fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let mcp: IMcpEndpoint;
let reader: { id: string; token: string };
let proposer: { id: string; token: string };
let stranger: { id: string; token: string };
const config = testConfig();
const ids: Record<string, string> = {};
const NIL = '00000000-0000-4000-8000-000000000000';
const FACADE = 'Фасад облицовывается керамогранитом толщиной 10 мм';

const counts = async () =>
  (
    await db.pool.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM mcp_proposal) AS proposals, (SELECT count(*) FROM finding) AS findings, (SELECT count(*) FROM customer_question) AS questions,
              (SELECT count(*) FROM decision) AS decisions, (SELECT count(*) FROM approval) AS approvals, (SELECT count(*) FROM release) AS releases`,
    )
  ).rows[0]!;
const sqlCode = async (sql: string, params: unknown[] = []): Promise<string | null> => {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};
const finding = (requestId: string, extra: Record<string, unknown> = {}) => ({ tenderId: s.tenderA, stageId: s.stageA, title: 'Толщина облицовки не подтверждена расчётом', body: 'В ТЗ 10 мм, в расчёте позиция отсутствует.', citedFragmentIds: [ids.fragA], requestId, ...extra });

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  ids.revA = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ-A.pdf');
  ids.runA = await seedEvidenceRun(db.pool, ids.revA!, { pages: [{ blocks: [FACADE, 'Кровля плоская'] }] });
  ids.revB = await uploadDocument(db, config, s.eng3, s.stageB, 'ТЗ-B.pdf');
  ids.runB = await seedEvidenceRun(db.pool, ids.revB!, { pages: [{ blocks: ['Отдельное условие тендера B'] }] });
  await setWorkingSet(s.eng1, s.stageA, [ids.revA!], true);
  await setWorkingSet(s.eng3, s.stageB, [ids.revB!]);
  await fixScope(s.eng1, s.stageA);
  await buildIndex(db, worker);
  ids.fragA = await fragmentIdOf(db.pool, ids.runA!, FACADE);
  ids.fragB = await fragmentIdOf(db.pool, ids.runB!, 'Отдельное условие тендера B');
  mcp = await startMcp(app);
  reader = await issueToken(s.eng1);
  proposer = await issueToken(s.eng1, { propose: true, name: 'с правом предлагать' });
  stranger = await issueToken(s.eng3, { propose: true });
}, 300_000);
afterAll(async () => {
  await mcp?.close();
  await db?.drop();
});

describe('область токена', () => {
  it('у токена без propose инструментов предложений нет в списке, а прямой вызов не выполняется', async () => {
    const client = await mcpClient(mcp.url, reader.token);
    expect((await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('propose_'))).toEqual([]);
    const before = await counts();
    const r = await client.callTool({ name: 'propose_finding', arguments: finding('req-no-scope-1') }).then(
      (x) => x as { isError?: boolean },
      () => ({ isError: true }),
    );
    expect(r.isError).toBe(true);
    expect(await counts()).toEqual(before);
    await client.close();
  });

  it('с областью propose видны четыре инструмента предложений; действий человека среди инструментов нет', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).filter((n) => n.startsWith('propose_')).sort()).toEqual(['propose_change_reason', 'propose_condition_text', 'propose_finding', 'propose_question']);
    for (const t of tools.filter((x) => x.name.startsWith('propose_'))) expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.map((t) => t.name).filter((n) => /approve|release_candidate|send_|resolve|accept|sql|shell|file|capture/i.test(n))).toEqual([]);
    await client.close();
  });
});

describe('предложение и повтор (A37)', () => {
  it('предложение сохраняется открытым и ничего не меняет: замечаний, вопросов, решений и согласований не появляется', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const before = await counts();
    const r = await callTool(client, 'propose_finding', finding('req-finding-0001', { severityHint: 'major' }));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.proposal).toMatchObject({ kind: 'finding', status: 'open', repeat: false });
    expect(r.body.note).toContain('пока его не примет человек');
    const after = await counts();
    expect(after).toEqual({ ...before, proposals: Number(before.proposals) + 1 });
    const row = (await db.pool.query('SELECT kind, status, title, detail, on_behalf_of_user_id, api_token_id, decided_by FROM mcp_proposal WHERE id = $1', [r.body.proposal.id])).rows[0];
    expect(row).toMatchObject({ kind: 'finding', status: 'open', detail: { severityHint: 'major' }, on_behalf_of_user_id: s.ids.eng1, api_token_id: proposer.id, decided_by: null });
    const cited = await db.pool.query('SELECT fragment_id FROM mcp_proposal_fragment WHERE proposal_id = $1', [r.body.proposal.id]);
    expect(cited.rows).toEqual([{ fragment_id: ids.fragA }]);
    // Текст предложения в журнал не пишется.
    const audit = (await db.pool.query<{ details: Record<string, unknown>; principal_kind: string }>("SELECT details, principal_kind FROM audit_event WHERE action = 'mcp.propose_finding' AND entity_id = $1", [r.body.proposal.id])).rows[0]!;
    expect(audit.principal_kind).toBe('model_via_mcp');
    expect(JSON.stringify(audit.details)).not.toContain('облицовки');
    await client.close();
  });

  it('повтор с тем же requestId возвращает ту же запись; тот же requestId с другим содержимым — отказ', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const first = await callTool(client, 'propose_question', { tenderId: s.tenderA, stageId: s.stageA, text: 'Подтвердите толщину облицовки фасада', citedFragmentIds: [ids.fragA], requestId: 'req-question-0001' });
    expect(first.isError, first.text).toBe(false);
    const before = await counts();
    const again = await Promise.all([1, 2, 3].map(() => callTool(client, 'propose_question', { tenderId: s.tenderA, stageId: s.stageA, text: 'Подтвердите толщину облицовки фасада', citedFragmentIds: [ids.fragA], requestId: 'req-question-0001' })));
    for (const r of again) expect(r.body.proposal).toMatchObject({ id: first.body.proposal.id, status: 'open', repeat: true });
    expect(await counts()).toEqual(before);
    const other = await callTool(client, 'propose_question', { tenderId: s.tenderA, stageId: s.stageA, text: 'Совсем другой вопрос', requestId: 'req-question-0001' });
    expect(other.body.error).toMatchObject({ code: 'invalid_request' });
    expect(await counts()).toEqual(before);
    // У другого пользователя тот же requestId — своя запись.
    const b = await mcpClient(mcp.url, stranger.token);
    const theirs = await callTool(b, 'propose_question', { tenderId: s.tenderB, stageId: s.stageB, text: 'Вопрос по тендеру B', requestId: 'req-question-0001' });
    expect(theirs.body.proposal.repeat).toBe(false);
    expect(theirs.body.proposal.id).not.toBe(first.body.proposal.id);
    await b.close();
    await client.close();
  });

  it('текст условия с ключом поля сохраняется предложением', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const r = await callTool(client, 'propose_condition_text', { tenderId: s.tenderA, stageId: s.stageA, fieldKey: 'payment.advance', text: 'Аванс 30 % в течение 10 банковских дней', requestId: 'req-condition-0001' });
    expect(r.isError, r.text).toBe(false);
    expect((await db.pool.query('SELECT kind, detail FROM mcp_proposal WHERE id = $1', [r.body.proposal.id])).rows[0]).toEqual({ kind: 'condition_text', detail: { fieldKey: 'payment.advance' } });
    await client.close();
  });
});

describe('цитаты и область', () => {
  it('несуществующая и чужая цитата — invalid_citation без создания записи', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const before = await counts();
    for (const bad of [[NIL], [ids.fragB], [ids.fragA, ids.fragB]]) {
      const r = await callTool(client, 'propose_finding', finding(`req-bad-${bad.length}-${bad[0]!.slice(0, 8)}`, { citedFragmentIds: bad }));
      expect(r.isError).toBe(true);
      expect(r.body.error).toMatchObject({ code: 'invalid_citation' });
    }
    expect(await counts()).toEqual(before);
    await client.close();
  });

  it('без области — needs_selection; чужой тендер — out_of_scope; замечание без цитат не принимается', async () => {
    const client = await mcpClient(mcp.url, proposer.token);
    const before = await counts();
    const noScope = await callTool(client, 'propose_question', { text: 'Какой аванс по Сокольникам?', requestId: 'req-noscope-0001' });
    expect(noScope.body.error).toMatchObject({ code: 'needs_selection' });
    const foreign = await callTool(client, 'propose_question', { tenderId: s.tenderB, stageId: s.stageB, text: 'Вопрос в чужой тендер', requestId: 'req-foreign-0001' });
    expect(foreign.body.error).toEqual({ code: 'out_of_scope', message: 'объект вне области запроса или недоступен' });
    const noCitations = await client.callTool({ name: 'propose_finding', arguments: finding('req-nocite-0001', { citedFragmentIds: [] }) }).then(
      (x) => x as { isError?: boolean },
      () => ({ isError: true }),
    );
    expect(noCitations.isError).toBe(true);
    expect(await counts()).toEqual(before);
    await client.close();
  });
});

describe('решение человека в портале', () => {
  const propose = async (tool: string, args: Record<string, unknown>) => {
    const client = await mcpClient(mcp.url, proposer.token);
    const r = await callTool(client, tool, { tenderId: s.tenderA, stageId: s.stageA, ...args });
    await client.close();
    expect(r.isError, r.text).toBe(false);
    return r.body.proposal.id as string;
  };
  const listed = async (client = s.eng2) => (await client.get(`/stages/${s.stageA}/mcp-proposals`)).body.items as any[];
  const etagOf = async (id: string) => (await listed()).find((p) => p.id === id).etag as string;

  it('список предложений этапа виден участникам тендера; не участнику — 404', async () => {
    const id = await propose('propose_finding', { title: 'Нет позиции под облицовку', body: 'В расчёте нет позиции под керамогранит.', citedFragmentIds: [ids.fragA], requestId: 'req-human-list-0001' });
    const mine = (await listed()).find((p) => p.id === id);
    expect(mine).toMatchObject({ kind: 'finding', status: 'open', restricted: false, title: 'Нет позиции под облицовку', citedFragmentIds: [ids.fragA], proposedVia: 'chat', proposedOnBehalfOf: { id: s.ids.eng1 }, can: { decide: true } });
    expect((await s.eng3.get(`/stages/${s.stageA}/mcp-proposals`)).status).toBe(404);
    expect((await s.eng2.get(`/stages/${s.stageA}/mcp-proposals?status=accepted`)).body.items.every((p: any) => p.status === 'accepted')).toBe(true);
  });

  it('принятие замечания: автор — человек, серьёзность задаёт он; предложение принято один раз', async () => {
    const id = await propose('propose_finding', { title: 'Толщина облицовки не подтверждена', body: 'В ТЗ 10 мм, в расчёте позиции нет.', citedFragmentIds: [ids.fragA], severityHint: 'critical', requestId: 'req-human-accept-0001' });
    const before = await counts();
    const noSeverity = await s.eng2.post(`/mcp-proposals/${id}/accept`, {}, { headers: { 'If-Match': await etagOf(id), ...idem() } });
    expect(noSeverity.status).toBe(400);
    const stale = await s.eng2.post(`/mcp-proposals/${id}/accept`, { severity: 'minor', confidence: 'medium' }, { headers: { 'If-Match': `"${id}:99"`, ...idem() } });
    expect(stale.status).toBe(412);
    const key = idem();
    const etag = await etagOf(id);
    const ok = await s.eng2.post(`/mcp-proposals/${id}/accept`, { severity: 'minor', confidence: 'medium' }, { headers: { 'If-Match': etag, ...key } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'accepted', decidedBy: { id: s.ids.eng2 }, result: { type: 'finding' }, can: { decide: false } });
    const finding = (await db.pool.query('SELECT created_by, origin, kind, severity, title FROM finding WHERE id = $1', [ok.body.result.id])).rows[0];
    // Автор — принявший человек; подсказка модели («критичное») серьёзностью не стала.
    expect(finding).toMatchObject({ created_by: s.ids.eng2, origin: 'human', kind: 'human', severity: 'minor', title: 'Толщина облицовки не подтверждена' });
    expect(await counts()).toEqual({ ...before, findings: Number(before.findings) + 1 });
    // Повтор той же команды записи не дублирует; новая команда по принятому предложению — отказ.
    const replay = await s.eng2.post(`/mcp-proposals/${id}/accept`, { severity: 'minor', confidence: 'medium' }, { headers: { 'If-Match': etag, ...key } });
    expect(replay.status).toBe(200);
    const again = await s.eng2.post(`/mcp-proposals/${id}/accept`, { severity: 'major', confidence: 'high' }, { headers: { 'If-Match': ok.body.etag, ...idem() } });
    expect(again.status).toBe(409);
    expect(again.body.current).toMatchObject({ reason: 'proposal_not_open' });
    expect(await counts()).toEqual({ ...before, findings: Number(before.findings) + 1 });
    const audit = await auditRows(db.pool, "action = 'mcp.proposal.accept' AND outcome = 'allowed' AND entity_id = $1", [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: s.ids.eng2 });
    expect(JSON.stringify(audit[0]!.details)).not.toContain('облицовки');
  });

  it('вопрос принимается черновиком вопроса заказчику; текст условия — без записи; отклонение — с причиной', async () => {
    const question = await propose('propose_question', { text: 'Подтвердите марку керамогранита', requestId: 'req-human-question-0001' });
    const before = await counts();
    const accepted = await s.manager.post(`/mcp-proposals/${question}/accept`, {}, { headers: { 'If-Match': await etagOf(question), ...idem() } });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.result).toMatchObject({ type: 'customer_question' });
    expect((await db.pool.query('SELECT status, text, created_by FROM customer_question WHERE id = $1', [accepted.body.result.id])).rows[0]).toEqual({ status: 'draft', text: 'Подтвердите марку керамогранита', created_by: s.ids.manager });
    expect(await counts()).toEqual({ ...before, questions: Number(before.questions) + 1 });

    const condition = await propose('propose_condition_text', { text: 'Гарантия 5 лет с даты подписания акта', fieldKey: 'warranty.term', requestId: 'req-human-condition-0001' });
    const taken = await s.eng2.post(`/mcp-proposals/${condition}/accept`, {}, { headers: { 'If-Match': await etagOf(condition), ...idem() } });
    expect(taken.status, taken.text).toBe(200);
    expect(taken.body).toMatchObject({ status: 'accepted', result: null, body: 'Гарантия 5 лет с даты подписания акта', detail: { fieldKey: 'warranty.term' } });

    const other = await propose('propose_question', { text: 'Лишний вопрос', requestId: 'req-human-reject-0001' });
    expect((await s.eng2.post(`/mcp-proposals/${other}/reject`, {}, { headers: { 'If-Match': await etagOf(other), ...idem() } })).status).toBe(400);
    const rejected = await s.eng2.post(`/mcp-proposals/${other}/reject`, { reason: 'Вопрос уже задан заказчику' }, { headers: { 'If-Match': await etagOf(other), ...idem() } });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionReason: 'Вопрос уже задан заказчику', result: null });
  });

  it('решить может только участник тендера с нужной возможностью; чат-клиент решить не может', async () => {
    const id = await propose('propose_question', { text: 'Вопрос для проверки прав', requestId: 'req-human-rights-0001' });
    const etag = await etagOf(id);
    expect((await s.eng3.post(`/mcp-proposals/${id}/accept`, {}, { headers: { 'If-Match': etag, ...idem() } })).status).toBe(404);
    expect([403, 404]).toContain((await s.admin.post(`/mcp-proposals/${id}/accept`, {}, { headers: { 'If-Match': etag, ...idem() } })).status);
    // Через MCP инструмента принятия нет ни у одного токена.
    const client = await mcpClient(mcp.url, proposer.token);
    expect((await client.listTools()).tools.map((t) => t.name).filter((n) => /accept|reject|decide/i.test(n))).toEqual([]);
    await client.close();
    expect((await listed()).find((p) => p.id === id).status).toBe('open');
  });
});

describe('вторая линия БД: предложение не становится решением без человека', () => {
  let id: string;
  beforeAll(async () => {
    id = (await db.pool.query<{ id: string }>("SELECT id FROM mcp_proposal WHERE kind = 'finding' AND status = 'open' LIMIT 1")).rows[0]!.id;
  });

  it('содержимое неизменно, удаление запрещено, цитаты добавляются только при создании', async () => {
    expect(await sqlCode("UPDATE mcp_proposal SET body = 'подменено' WHERE id = $1", [id])).toBe('55000');
    expect(await sqlCode('UPDATE mcp_proposal SET on_behalf_of_user_id = $2 WHERE id = $1', [id, s.ids.manager])).toBe('55000');
    // У роли приложения нет права удаления: отказ даёт либо оно, либо охранник.
    expect(['55000', '42501']).toContain(await sqlCode('DELETE FROM mcp_proposal WHERE id = $1', [id]));
    expect(await sqlCode('INSERT INTO mcp_proposal_fragment (proposal_id, fragment_id, ordinal) VALUES ($1, $2, 9)', [id, ids.fragA])).toBe('55000');
    expect(['55000', '42501']).toContain(await sqlCode('DELETE FROM mcp_proposal_fragment WHERE proposal_id = $1', [id]));
  });

  it('решение принимает только человек тендера с нужной возможностью, один раз', async () => {
    // Не участник тендера и администратор без роли в тендере принять не могут.
    for (const user of [s.ids.eng3, s.ids.admin]) {
      expect(await sqlCode("UPDATE mcp_proposal SET status = 'accepted', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [id, user])).toBe('42501');
    }
    expect(await sqlCode("UPDATE mcp_proposal SET status = 'accepted', row_version = row_version + 1 WHERE id = $1", [id])).not.toBeNull();
    expect(await sqlCode("UPDATE mcp_proposal SET status = 'rejected', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [id, s.ids.eng2])).toBe('23514');
    expect(await sqlCode("UPDATE mcp_proposal SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = 'дубль', row_version = row_version + 1 WHERE id = $1", [id, s.ids.eng2])).toBeNull();
    expect(await sqlCode("UPDATE mcp_proposal SET status = 'accepted', decided_by = $2, decided_at = now(), row_version = row_version + 1 WHERE id = $1", [id, s.ids.manager])).toBe('55000');
  });

  it('прямая запись предложения без действующего токена с областью propose или без права в тендере не принимается', async () => {
    const insert = (token: string, user: string, tender: string, stage: string) =>
      sqlCode(
        `INSERT INTO mcp_proposal (tender_id, stage_id, kind, body, request_id, request_sha256, api_token_id, on_behalf_of_user_id)
         VALUES ($1, $2, 'question', 'прямая запись', $3, repeat('a', 64), $4, $5)`,
        [tender, stage, `direct-${Math.random().toString(36).slice(2)}-0000`, token, user],
      );
    expect(await insert(reader.id, s.ids.eng1, s.tenderA, s.stageA)).toBe('42501');
    expect(await insert(proposer.id, s.ids.manager, s.tenderA, s.stageA)).toBe('42501');
    expect(await insert(stranger.id, s.ids.eng3, s.tenderA, s.stageA)).toBe('42501');
    expect(await insert(proposer.id, s.ids.eng1, s.tenderA, s.stageB)).toBe('23514');
    expect(await insert(proposer.id, s.ids.eng1, s.tenderA, s.stageA)).toBeNull();
  });
});
