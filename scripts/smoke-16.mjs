// Шаги smoke этапа 16 (ADR-010, D-037): MCP портала на настоящих server + worker. Проверяется то, что видит чат-клиент:
// токен выпускается обычной командой и показывается один раз, точка /mcp принимает только его, инструменты отвечают по
// правам владельца токена, вопрос без области — needs_selection, предложение сохраняется открытым и не дублируется,
// отозванный токен не принимается. Запросы — JSON-RPC по HTTP, как их шлёт клиент; подключением Codex или Cursor это не
// является (живая проверка клиентов — отдельно). Вызывается из scripts/smoke.mjs.
export const smokeMcp = async ({ base, api, record, json, tenderId, stageId, secretMarker }) => {
  const rpc = async (token, method, params, headers = {}) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const raw = await r.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      const m = /^data: (.*)$/m.exec(raw);
      body = m ? JSON.parse(m[1]) : null;
    }
    return { status: r.status, body, raw };
  };
  const tool = async (token, name, args = {}) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    const text = r.body?.result?.content?.[0]?.text;
    return { status: r.status, isError: r.body?.result?.isError === true, data: text ? JSON.parse(text) : null, raw: r.raw };
  };

  const issued = await api('/me/api-tokens', { method: 'POST', headers: json, body: JSON.stringify({ name: 'smoke', clientKind: 'other', propose: true, lifetimeDays: 7 }) });
  const issuedBody = issued.status === 201 ? await issued.json() : null;
  const token = issuedBody?.token ?? '';
  const listed = await (await api('/me/api-tokens')).json();
  record(
    'этап 16: токен чат-клиента выпущен, значение — только в ответе выпуска; в списке — первые символы',
    /^kkp_[A-Za-z0-9_-]{43}$/.test(token) && listed.items?.some((t) => t.id === issuedBody.id && t.state === 'active') && !JSON.stringify(listed).includes(token),
    `HTTP ${issued.status}`,
  );

  const anonymous = await rpc(null, 'tools/list', {});
  const viaApi = await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
  const wrongMethod = await fetch(`${base}/mcp`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const foreignOrigin = await rpc(token, 'tools/list', {}, { Origin: 'https://evil.example.test' });
  record(
    'этап 16: точка /mcp — только POST с токеном; чужой Origin — 403; токен на /api/v1 не принимается',
    anonymous.status === 401 && viaApi.status === 401 && wrongMethod.status === 405 && foreignOrigin.status === 403,
    `HTTP ${anonymous.status}/${viaApi.status}/${wrongMethod.status}/${foreignOrigin.status}`,
  );

  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } });
  const list = await rpc(token, 'tools/list', {});
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  record(
    'этап 16: сервер MCP отвечает клиенту — 15 инструментов чтения и 4 предложений, действий человека нет',
    init.body?.result?.serverInfo?.name === 'kontur-kp' && names.length === 19 && names.filter((n) => n.startsWith('propose_')).length === 4 && !names.some((n) => /approve|release_candidate|send_|resolve|accept|sql|shell/i.test(n)),
    names.length ? `${names.length} инструментов` : `HTTP ${list.status}`,
  );

  const cases = await tool(token, 'list_cases');
  const noScope = await tool(token, 'search_evidence', { query: 'Какой аванс по договору?' });
  const overview = await tool(token, 'get_case_overview', { tenderId, stageId });
  const status = await tool(token, 'get_integration_status');
  record(
    'этап 16: инструменты отвечают по правам владельца токена; без области — needs_selection; секретов в ответах нет',
    cases.data?.cases?.some((c) => c.code === 'DEMO-001') &&
      noScope.isError &&
      noScope.data?.error?.code === 'needs_selection' &&
      overview.isError === false &&
      overview.data?.stageId === stageId &&
      status.data?.integrations?.some((i) => i.system === 'mcp' && i.status === 'VERIFIED_FIXTURE') &&
      ![cases, noScope, overview, status].some((r) => r.raw.includes(secretMarker) || r.raw.includes(token)),
    `HTTP ${cases.status}/${overview.status}`,
  );

  const args = { tenderId, stageId, text: 'Smoke: подтвердите срок действия предложения', requestId: 'smoke-16-question-0001' };
  const first = await tool(token, 'propose_question', args);
  const again = await tool(token, 'propose_question', args);
  const proposals = await (await api(`/stages/${stageId}/mcp-proposals`)).json();
  const mine = proposals.items?.find((p) => p.id === first.data?.proposal?.id);
  record(
    'этап 16: предложение чат-клиента сохранено открытым и ждёт человека; повтор с тем же requestId — та же запись',
    first.isError === false && again.data?.proposal?.id === first.data.proposal.id && again.data.proposal.repeat === true && mine?.status === 'open' && mine?.can?.decide === true,
    `HTTP ${first.status}`,
  );

  const revoked = await api(`/api-tokens/${issuedBody?.id}`, { method: 'DELETE' });
  const afterRevoke = await rpc(token, 'tools/list', {});
  record('этап 16: отозванный токен точка /mcp не принимает', revoked.status === 200 && afterRevoke.status === 401, `HTTP ${revoked.status}/${afterRevoke.status}`);

  return { tokenId: issuedBody?.id ?? null, proposalId: first.data?.proposal?.id ?? null, stageId };
};
