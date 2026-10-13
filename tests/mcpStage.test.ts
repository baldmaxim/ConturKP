// Этап 16 (проект §5, §12): инструменты чтения этапа и выпуска на данных полного пути — требования, расчёт, проверки,
// комплекты, два выпуска. Проверки задания: исторический вопрос (A11), отсутствие цены, неверный вид цены, сравнение двух
// выпусков, матрица ролей через MCP. Боевой выпуск — на данных фикстуры (Q-01/X-01, Q-05, Q-08 в силе); данные поддельные.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeStage13, rerunReview } from './approvalFixtures.ts';
import { idem } from './helpers.ts';
import { callTool, issueToken, mcpClient, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { buildIndex, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import { buildStage15, released, settle, type IReleased, type IStage15 } from './sendFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

let st: IStage15;
let first: IReleased;
let second: IReleased;
let mcp: IMcpEndpoint;
let eng1: { id: string; token: string };
let proposer: { id: string; token: string };
let manager: { id: string; token: string };
let outsider: { id: string; token: string };
let emptyStage: string;
let lateFragment: string;
const LATE = 'ПОЗДНЕЕ-УСЛОВИЕ-16: гарантийный срок увеличен до семи лет';
const NIL = '00000000-0000-4000-8000-000000000000';

const scope = () => ({ tenderId: st.e.s.tenderA, stageId: st.e.s.stageA });
const withClient = async <T>(token: string, fn: (c: Awaited<ReturnType<typeof mcpClient>>) => Promise<T>): Promise<T> => {
  const client = await mcpClient(mcp.url, token);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
};
const ok = async (client: Awaited<ReturnType<typeof mcpClient>>, name: string, args: Record<string, unknown>) => {
  const r = await callTool(client, name, args);
  expect(r.isError, `${name}: ${r.text.slice(0, 400)}`).toBe(false);
  return r.body;
};

beforeAll(async () => {
  st = await buildStage15();
  first = await released(st);
  await rerunReview(st);
  second = await released(st);
  // После обоих выпусков в этап поступает новый документ: в снимках выпусков его нет.
  const late = await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Позднее дополнение.pdf');
  const run = await seedEvidenceRun(st.db.pool, late, { pages: [{ blocks: [LATE] }] });
  lateFragment = await fragmentIdOf(st.db.pool, run, LATE);
  await setWorkingSet(st.e.s.eng1, st.e.s.stageA, [st.tzRev, late], true);
  await buildIndex(st.db, st.e.worker);
  const stage = await st.e.s.manager.post(`/tenders/${st.e.s.tenderA}/stages`, { title: 'Этап без расчёта' }, { headers: idem() });
  expect(stage.status, stage.text).toBe(201);
  emptyStage = stage.body.id as string;
  mcp = await startMcp(st.e.app);
  eng1 = await issueToken(st.e.s.eng1);
  proposer = await issueToken(st.e.s.eng1, { propose: true, name: 'предложения' });
  manager = await issueToken(st.e.s.manager);
  outsider = await issueToken(st.e.s.eng3);
});
afterEach(async () => settle(st));
afterAll(async () => {
  await mcp?.close();
  if (st) await closeStage13(st);
});

describe('обзор, документы, требования', () => {
  it('get_case_overview: набор источников, ревизия расчёта, последняя проверка, комплект и выпуски', async () => {
    await withClient(eng1.token, async (c) => {
      const o = await ok(c, 'get_case_overview', scope());
      expect(o.sourceSet.working).toMatchObject({ status: expect.any(String) });
      expect(o.calculation.latestRevision).toMatchObject({ kind: expect.any(String), counts: expect.any(Object) });
      expect(o.lastReviewRun).toMatchObject({ status: expect.any(String) });
      expect(o.latestCandidate).toMatchObject({ restricted: false, status: expect.any(String) });
      expect(o.releases.map((r: any) => r.releaseId).sort()).toEqual([first.releaseId, second.releaseId].sort());
      expect(o.openChatProposals).toBe(0);
    });
  });

  it('list_documents: документы этапа постранично; чужой курсор не принимается', async () => {
    await withClient(eng1.token, async (c) => {
      const all = await ok(c, 'list_documents', scope());
      expect(all.scope).toBe('stage');
      expect(all.documents.map((d: any) => d.title)).toContain('Позднее дополнение.pdf');
      expect(all.total).toBeGreaterThanOrEqual(2);
      const page1 = await ok(c, 'list_documents', { ...scope(), limit: 1 });
      expect(page1.documents).toHaveLength(1);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = await ok(c, 'list_documents', { ...scope(), limit: 1, cursor: page1.nextCursor });
      expect(page2.documents[0].documentId ?? page2.documents[0].documentRevisionId).not.toBe(page1.documents[0].documentId ?? page1.documents[0].documentRevisionId);
      // Курсор привязан к инструменту и области.
      const foreign = await callTool(c, 'list_documents', { tenderId: st.e.s.tenderA, stageId: emptyStage, cursor: page1.nextCursor });
      expect(foreign.body.error).toMatchObject({ code: 'invalid_request' });
      expect((await callTool(c, 'list_requirements', { ...scope(), cursor: page1.nextCursor })).body.error).toMatchObject({ code: 'invalid_request' });
    });
  });

  it('list_requirements: формулировки и основания; основание открывается get_citation', async () => {
    await withClient(eng1.token, async (c) => {
      const r = await ok(c, 'list_requirements', scope());
      expect(r.total).toBeGreaterThan(0);
      const item = r.requirements.find((x: any) => !x.restricted && x.evidence.length > 0);
      expect(item).toMatchObject({ code: expect.stringMatching(/^R-/), statement: expect.any(String), restricted: false });
      const cited = await ok(c, 'get_citation', { fragmentId: item.evidence[0].fragmentId });
      expect(cited.citation.text).toEqual(expect.any(String));
    });
  });
});

describe('расчёт и экономика', () => {
  it('get_calculation: итоги, позиции и строки постранично; у каждой суммы — валюта, признак НДС и вид цены', async () => {
    await withClient(eng1.token, async (c) => {
      const totals = await ok(c, 'get_calculation', { ...scope(), view: 'totals' });
      expect(totals.revision).toMatchObject({ kind: expect.any(String), seq: expect.any(Number) });
      expect(totals.totals).toHaveProperty('source');
      const positions = await ok(c, 'get_calculation', { ...scope(), view: 'positions', limit: 2 });
      expect(positions.positions).toHaveLength(2);
      expect(positions.nextCursor).toEqual(expect.any(String));
      const more = await ok(c, 'get_calculation', { ...scope(), view: 'positions', limit: 2, cursor: positions.nextCursor });
      expect(more.positions[0].externalPositionId).not.toBe(positions.positions[0].externalPositionId);
      const lines = await ok(c, 'get_calculation', { ...scope(), view: 'lines', limit: 3 });
      expect(lines.lines.length).toBeGreaterThan(0);
      // Деньги — объекты с валютой, НДС и видом цены; «голых» чисел без вида цены в итогах позиции нет.
      const money: any[] = [];
      const walk = (v: unknown): void => {
        if (v && typeof v === 'object') {
          if ('amount' in (v as object) && 'priceKind' in (v as object)) money.push(v);
          for (const x of Object.values(v as object)) walk(x);
        }
      };
      walk(positions.positions);
      walk(lines.lines);
      expect(money.length).toBeGreaterThan(0);
      for (const m of money) {
        expect(m.amount).toMatch(/^-?\d+(\.\d+)?$/);
        expect(['cost', 'commercial']).toContain(m.priceKind);
        expect(m.currency).toEqual(expect.any(String));
        expect(m).toHaveProperty('vat');
      }
    });
  });

  it('get_economics: себестоимость и коммерческая цена раздельно, сверка с источником; итогом КП отчёт не называется', async () => {
    await withClient(eng1.token, async (c) => {
      const e = await ok(c, 'get_economics', scope());
      expect(e.economics.totals.cost).toMatchObject({ priceKind: 'cost', amount: expect.stringMatching(/^-?\d+(\.\d+)?$/) });
      expect(e.economics.totals.commercial).toMatchObject({ priceKind: 'commercial' });
      expect(e.economics.reconciliation).toMatchObject({ isKpTotal: false });
      // По выпуску — экономика ревизии, закреплённой его комплектом.
      const pinned = await ok(c, 'get_economics', { tenderId: st.e.s.tenderA, releaseId: first.releaseId });
      expect(pinned.revision.id).toEqual(expect.any(String));
    });
  });

  it('отсутствие цены: у этапа без расчёта — «нет данных» с причиной, а не ноль', async () => {
    await withClient(eng1.token, async (c) => {
      const empty = { tenderId: st.e.s.tenderA, stageId: emptyStage };
      const calc = await ok(c, 'get_calculation', { ...empty, view: 'totals' });
      expect(calc).toMatchObject({ revision: null, noData: { reason: 'no_calculation_revision' } });
      expect(JSON.stringify(calc)).not.toMatch(/"amount":"0/);
      const econ = await ok(c, 'get_economics', empty);
      expect(econ).toMatchObject({ economics: null, noData: { reason: 'no_calculation_revision' } });
      const overview = await ok(c, 'get_case_overview', empty);
      expect(overview.calculation).toMatchObject({ latestRevision: null, noData: { reason: 'no_calculation_revision' } });
      expect((await ok(c, 'get_readiness', empty)).noData).toMatchObject({ reason: 'no_candidate' });
      expect((await ok(c, 'list_requirements', empty)).noData).toMatchObject({ reason: 'no_active_registry' });
    });
  });

  it('неверный вид цены: итог запрошенного вида или отказ — сумма другого вида вместо него не возвращается', async () => {
    await withClient(eng1.token, async (c) => {
      const cost = await ok(c, 'get_economics', { ...scope(), priceKind: 'cost' });
      const commercial = await ok(c, 'get_economics', { ...scope(), priceKind: 'commercial' });
      expect(cost).toMatchObject({ priceKind: 'cost', total: { priceKind: 'cost' } });
      expect(commercial).toMatchObject({ priceKind: 'commercial', total: { priceKind: 'commercial' } });
      // В ответе на один вид цены нет сумм другого вида.
      expect(JSON.stringify(cost.total)).not.toContain('"commercial"');
      expect(JSON.stringify(commercial.total)).not.toContain('"priceKind":"cost"');
      expect(cost.availableKinds).toEqual(['cost', 'commercial']);
      // Вид цены, которого в портале нет (розничная, с НДС), — отказ с перечнем допустимых значений.
      for (const priceKind of ['retail', 'with_vat', 'КП']) {
        const r = await c.callTool({ name: 'get_economics', arguments: { ...scope(), priceKind } }).then(
          (x) => x as { isError?: boolean; content?: { text?: string }[] },
          (e: unknown) => ({ isError: true, content: [{ text: String(e) }] }),
        );
        expect(r.isError, priceKind).toBe(true);
        expect(JSON.stringify(r.content)).toMatch(/cost|commercial/);
      }
    });
  });

  it('неверный вид данных расчёта — отказ, а не подмена другим видом', async () => {
    await withClient(eng1.token, async (c) => {
      for (const view of ['profit', 'price', '']) {
        const r = await c.callTool({ name: 'get_calculation', arguments: { ...scope(), view } }).then(
          (x) => x as { isError?: boolean },
          () => ({ isError: true }),
        );
        expect(r.isError, view).toBe(true);
      }
    });
  });
});

describe('замечания, вопросы, решения, готовность', () => {
  it('list_findings, list_questions, list_decisions отвечают в пределах этапа', async () => {
    await withClient(eng1.token, async (c) => {
      const f = await ok(c, 'list_findings', scope());
      expect(f).toMatchObject({ findings: expect.any(Array), total: expect.any(Number) });
      for (const x of f.findings) expect(x).toMatchObject({ id: expect.any(String), severity: expect.any(String), status: expect.any(String) });
      expect((await ok(c, 'list_findings', { ...scope(), status: 'open', severity: 'critical' })).total).toBeLessThanOrEqual(f.total);
      const q = await ok(c, 'list_questions', scope());
      expect(q).toMatchObject({ questions: expect.any(Array), qaThreads: expect.any(Array) });
      const d = await ok(c, 'list_decisions', scope());
      expect(d).toMatchObject({ decisions: expect.any(Array), total: expect.any(Number) });
      for (const x of d.decisions) expect(['requirement', 'hold']).toContain(x.subject);
    });
  });

  it('get_readiness: комплект, удержания, выпуск, размещение и отправка — только чтение', async () => {
    await withClient(eng1.token, async (c) => {
      const stage = await ok(c, 'get_readiness', scope());
      expect(stage.candidate).toMatchObject({ restricted: false, id: second.candidate.id });
      expect(stage.holds).toMatchObject({ total: expect.any(Number), open: expect.any(Number) });
      expect(stage.release).toMatchObject({ releaseId: second.releaseId, mode: 'production', sendReadiness: { state: expect.any(String) }, send: { provesReceipt: false } });
      const byRelease = await ok(c, 'get_readiness', { tenderId: st.e.s.tenderA, releaseId: first.releaseId });
      expect(byRelease.candidate.id).toBe(first.candidate.id);
      expect(byRelease.release.releaseId).toBe(first.releaseId);
    });
    // Чтение готовности ничего не согласовало и не выпустило.
    expect((await st.db.pool.query('SELECT count(*)::int AS n FROM release')).rows[0].n).toBe(2);
  });
});

describe('исторический вопрос (A11)', () => {
  it('по выпуску — только его снимок источников: документ, поступивший позже, не находится и не перечисляется', async () => {
    await withClient(eng1.token, async (c) => {
      const run = async (args: Record<string, unknown>) => {
        const started = await ok(c, 'search_evidence', { ...args, query: 'гарантийный срок увеличен до семи лет ПОЗДНЕЕ-УСЛОВИЕ-16' });
        return ok(c, 'get_search_run', { searchRunId: started.searchRunId });
      };
      const now = await run(scope());
      expect(now.fragments.map((f: any) => f.fragmentId)).toContain(lateFragment);
      for (const releaseId of [first.releaseId, second.releaseId]) {
        const then = await run({ tenderId: st.e.s.tenderA, releaseId });
        expect(then.final).toBe(true);
        expect(then.fragments.map((f: any) => f.fragmentId)).not.toContain(lateFragment);
        expect(JSON.stringify(then)).not.toContain('ПОЗДНЕЕ-УСЛОВИЕ-16');
        const docs = await ok(c, 'list_documents', { tenderId: st.e.s.tenderA, releaseId });
        expect(docs.scope).toBe('release');
        expect(JSON.stringify(docs)).not.toContain('Позднее дополнение');
      }
      // Разные области — разные хэши области.
      expect((await run({ tenderId: st.e.s.tenderA, releaseId: first.releaseId })).scopeHash).not.toBe(now.scopeHash);
    });
  });
});

describe('сравнение двух выпусков', () => {
  it('compare_releases: по закреплённым записям, повторный вызов — то же сравнение; раздел и страницы', async () => {
    await withClient(eng1.token, async (c) => {
      const args = { tenderId: st.e.s.tenderA, leftReleaseId: second.releaseId, rightReleaseId: first.releaseId };
      const a = await ok(c, 'compare_releases', args);
      // Левая сторона — выпущенная раньше, в каком бы порядке ни пришли ID.
      expect(a).toMatchObject({ status: 'ready', methodVersion: 'release-compare/15-2', left: { releaseId: first.releaseId }, right: { releaseId: second.releaseId } });
      expect(a.resultSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(a.sections).sort()).toEqual(['applications', 'decisions', 'questions', 'received', 'requirements', 'sources', 'terms']);
      const b = await ok(c, 'compare_releases', { ...args, leftReleaseId: first.releaseId, rightReleaseId: second.releaseId });
      expect(b.comparisonId).toBe(a.comparisonId);
      expect(b.resultSha256).toBe(a.resultSha256);
      expect((await st.db.pool.query('SELECT count(*)::int AS n FROM release_comparison')).rows[0].n).toBe(1);
      const section = await ok(c, 'compare_releases', { ...args, section: 'decisions', limit: 1 });
      for (const i of section.items) expect(i.section).toBe('decisions');
      // Поздний документ в сравнение прежних выпусков не попал.
      expect(JSON.stringify(a)).not.toContain('Позднее дополнение');
      const none = await callTool(c, 'compare_releases', { tenderId: st.e.s.tenderA });
      expect(none.body.error).toMatchObject({ code: 'needs_selection' });
      expect((await callTool(c, 'compare_releases', { ...args, rightReleaseId: second.releaseId })).body.error).toMatchObject({ code: 'invalid_request' });
      expect((await callTool(c, 'compare_releases', { ...args, rightReleaseId: NIL })).body.error).toMatchObject({ code: 'out_of_scope' });
    });
  });

  it('propose_change_reason: причина вывода сравнения — предложением, запись причины не создаётся', async () => {
    await withClient(proposer.token, async (c) => {
      const cmp = await ok(c, 'compare_releases', { tenderId: st.e.s.tenderA, leftReleaseId: first.releaseId, rightReleaseId: second.releaseId });
      const item = cmp.items.find((i: any) => !i.closed);
      expect(item, 'у сравнения есть открытый для читателя вывод').toBeDefined();
      const requirements = await ok(c, 'list_requirements', scope());
      const fragmentId = requirements.requirements.find((x: any) => x.evidence.length > 0).evidence[0].fragmentId;
      const before = (await st.db.pool.query('SELECT count(*)::int AS n FROM release_comparison_reason')).rows[0].n;
      const r = await ok(c, 'propose_change_reason', { comparisonId: cmp.comparisonId, itemId: item.id, reasonKind: 'document', text: 'Изменение следует из уточнённого ТЗ', citedFragmentIds: [fragmentId], requestId: 'req-reason-16-0001' });
      expect(r.proposal).toMatchObject({ kind: 'change_reason', status: 'open', repeat: false });
      expect((await st.db.pool.query('SELECT count(*)::int AS n FROM release_comparison_reason')).rows[0].n).toBe(before);
      expect((await callTool(c, 'propose_change_reason', { comparisonId: cmp.comparisonId, itemId: NIL, reasonKind: 'document', text: 'x', citedFragmentIds: [fragmentId], requestId: 'req-reason-16-0002' })).body.error).toMatchObject({ code: 'out_of_scope' });
      expect((await ok(c, 'get_case_overview', scope())).openChatProposals).toBe(1);

      // Человек принимает предложение в портале: причина записана к выводу как гипотеза, от его имени.
      const listed = (await st.e.s.manager.get(`/stages/${st.e.s.stageA}/mcp-proposals`)).body.items.find((p: any) => p.id === r.proposal.id);
      expect(listed).toMatchObject({ kind: 'change_reason', status: 'open', restricted: false, can: { decide: true } });
      const accepted = await st.e.s.manager.post(`/mcp-proposals/${r.proposal.id}/accept`, {}, { headers: { 'If-Match': listed.etag, ...idem() } });
      expect(accepted.status, accepted.text).toBe(200);
      expect(accepted.body).toMatchObject({ status: 'accepted', result: { type: 'release_comparison_reason' }, decidedBy: { id: st.e.s.ids.manager } });
      const reason = (await st.db.pool.query('SELECT reason_status, reason_kind, rationale, actor_user_id FROM release_comparison_reason WHERE id = $1', [accepted.body.result.id])).rows[0];
      expect(reason).toEqual({ reason_status: 'hypothesis', reason_kind: 'document', rationale: 'Изменение следует из уточнённого ТЗ', actor_user_id: st.e.s.ids.manager });
      expect((await st.db.pool.query('SELECT count(*)::int AS n FROM release_comparison_reason')).rows[0].n).toBe(before + 1);
      // Чат-клиент видит ту же причину у вывода — со статусом «гипотеза», не «подтверждена».
      const after = await ok(c, 'compare_releases', { tenderId: st.e.s.tenderA, leftReleaseId: first.releaseId, rightReleaseId: second.releaseId });
      expect(after.items.find((i: any) => i.id === item.id)).toMatchObject({ reasonStatus: 'hypothesis', reasonVersion: 1 });
      expect((await ok(c, 'get_case_overview', scope())).openChatProposals).toBe(0);
    });
  });
});

describe('матрица ролей через MCP', () => {
  const READS: [string, Record<string, unknown>][] = [
    ['get_case_overview', {}],
    ['list_documents', {}],
    ['list_requirements', {}],
    ['get_calculation', { view: 'totals' }],
    ['get_economics', {}],
    ['list_findings', {}],
    ['list_questions', {}],
    ['list_decisions', {}],
    ['get_readiness', {}],
    ['search_evidence', { query: 'фасад' }],
  ];

  it('руководитель тендера читает всё; не участник получает out_of_scope на каждом инструменте', async () => {
    await withClient(manager.token, async (c) => {
      for (const [name, extra] of READS) expect((await callTool(c, name, { ...scope(), ...extra })).isError, name).toBe(false);
    });
    await withClient(outsider.token, async (c) => {
      for (const [name, extra] of READS) {
        const r = await callTool(c, name, { ...scope(), ...extra });
        expect(r.body.error, name).toEqual({ code: 'out_of_scope', message: 'объект вне области запроса или недоступен' });
      }
      expect((await callTool(c, 'compare_releases', { tenderId: st.e.s.tenderA, leftReleaseId: first.releaseId, rightReleaseId: second.releaseId })).body.error).toMatchObject({ code: 'out_of_scope' });
      expect((await callTool(c, 'list_documents', { tenderId: st.e.s.tenderB, releaseId: first.releaseId })).body.error).toMatchObject({ code: 'out_of_scope' });
    });
  });

  it('снятие с тендера и отключение пользователя действуют на следующий же вызов', async () => {
    const temp = await issueToken(st.e.s.eng2, { name: 'временный' });
    const client = await mcpClient(mcp.url, temp.token);
    expect((await callTool(client, 'get_case_overview', scope())).isError).toBe(false);
    const tender = await st.e.s.admin.get(`/tenders/${st.e.s.tenderA}`);
    const removed = await st.e.s.admin.delete(`/tenders/${st.e.s.tenderA}/members/${st.e.s.ids.eng2}`, { headers: { 'If-Match': tender.headers.etag as string } });
    expect(removed.status, removed.text).toBe(200);
    // Токен прежний, права — текущие: тендер исчез из области сразу.
    expect((await callTool(client, 'get_case_overview', scope())).body.error).toEqual({ code: 'out_of_scope', message: 'объект вне области запроса или недоступен' });
    expect((await callTool(client, 'list_cases')).body.cases.map((x: any) => x.tenderId)).not.toContain(st.e.s.tenderA);
    const users = await st.e.s.admin.get('/admin/users');
    const user = users.body.items.find((u: any) => u.id === st.e.s.ids.eng2);
    const disabled = await st.e.s.admin.patch(`/admin/users/${user.id}`, { status: 'disabled' }, { headers: { 'If-Match': `"${user.id}:${user.rowVersion}"` } });
    expect(disabled.status, disabled.text).toBe(200);
    // Отключённый пользователь: токен больше не принимается.
    const after = await client.callTool({ name: 'list_cases', arguments: {} }).then(
      () => 'ok',
      (e: unknown) => String(e),
    );
    expect(after).not.toBe('ok');
    const raw = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${temp.token}`, 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(raw.status).toBe(401);
    await client.close().catch(() => undefined);
  });
});
