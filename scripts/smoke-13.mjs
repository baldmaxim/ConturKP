// Шаги smoke этапа 13 (D-033): матрица блокеров, права и удержания на настоящих server + worker. Комплект — тестовый
// из шагов этапа 12; прогон проверок демо-этапа неполный (шаги этапа 09), поэтому согласование отклоняется неснимаемым
// блокером — это и проверяется: инженер не согласует (403), руководителю сервер отвечает 409 BLOCKER_PRESENT теми же
// кодами, что показывает карточка; неснимаемый блокер риском не снимается. Правка использованного поля после сборки
// ставит удержание; «не влияет» решает только руководитель. Полный путь согласования и выпуска — интеграционные тесты
// этапа 13 (tests/approval*.test.ts). Вызывается из scripts/smoke.mjs; после перезапуска server состояние проверяется там.
export const smokeApproval = async ({ api, api2, record, idem, json, stageId, candidateId }) => {
  if (!candidateId) {
    record('этап 13: нет комплекта из шагов этапа 12 — шаги согласования не выполнены', false);
    return { candidateId: null, hard: [] };
  }
  const view = async (client = api) => (await client(`/release-candidates/${candidateId}`)).json();
  const openBlockers = (g) => (g?.blockers ?? []).filter((b) => b.open > 0);
  let c = await view();
  const hard = openBlockers(c.gate?.approve).filter((b) => !b.acceptable).map((b) => b.code);
  // Неснимаемые блокеры, которые не зависят от решений по событиям (INPUTS_CHANGED снимается решением «не влияет»).
  const stable = hard.filter((code) => code !== 'INPUTS_CHANGED');
  record(
    'этап 13: карточка комплекта — оценка матрицы согласования с классами блокеров; неполная проверка демо-этапа — неснимаемый блокер',
    c.status === 'ready_for_approval' && Array.isArray(c.gate?.approve?.blockers) && hard.length > 0 && c.can?.approve === true,
    `неснимаемые: ${hard.join(', ') || '—'}`,
  );
  const approveBody = JSON.stringify({ contentHash: c.contentHash });
  const eng = await api2(`/release-candidates/${candidateId}/approve`, { method: 'POST', headers: { ...json, ...idem(), 'If-Match': c.etag }, body: approveBody });
  const mgr = await api(`/release-candidates/${candidateId}/approve`, { method: 'POST', headers: { ...json, ...idem(), 'If-Match': c.etag }, body: approveBody });
  const mgrBody = mgr.status === 409 ? await mgr.json() : null;
  record(
    'этап 13: инженер не согласует (403); руководителю матрица отказывает — 409 BLOCKER_PRESENT с кодами карточки',
    eng.status === 403 && mgrBody?.code === 'BLOCKER_PRESENT' && hard.every((code) => mgrBody.blockers.some((b) => b.code === code)),
    `HTTP ${eng.status}/${mgr.status}`,
  );
  const risk = hard[0]
    ? await api(`/release-candidates/${candidateId}/risk-acceptances`, {
        method: 'POST',
        headers: { ...json, ...idem() },
        body: JSON.stringify({ blockerCode: hard[0], subjectType: 'candidate', subjectId: candidateId, reason: 'smoke: попытка принять неснимаемый риск' }),
      })
    : null;
  const riskBody = risk ? await risk.json() : null;
  record('этап 13: неснимаемый блокер риском не снимается — 409 risk_not_acceptable', risk?.status === 409 && riskBody?.current?.reason === 'risk_not_acceptable', `HTTP ${risk?.status}`);

  // Удержание: правка использованного поля приложения после сборки (событие draft_field_changed).
  const draftId = c.inputs?.drafts?.[0]?.id;
  const draft = draftId ? await (await api2(`/application-drafts/${draftId}`)).json() : null;
  const field = draft?.sections?.flatMap((s) => s.fields).find((f) => f.key === 'subject');
  const put = field
    ? await api2(`/application-drafts/${draftId}/fields/subject`, {
        method: 'PUT',
        headers: { ...json, 'If-Match': field.etag },
        body: JSON.stringify({ action: 'set', value: 'Строительство демонстрационного объекта (уточнено)', bases: [] }),
      })
    : null;
  c = await view();
  const holds = (await (await api(`/stages/${stageId}/holds?candidateId=${candidateId}&status=open`)).json()).items ?? [];
  record(
    'этап 13: правка использованного поля после сборки — удержание у комплекта, согласование заблокировано INPUTS_CHANGED',
    put?.status === 200 && c.current === false && holds.some((h) => h.event.type === 'draft_field_changed') && openBlockers(c.gate?.approve).some((b) => b.code === 'INPUTS_CHANGED'),
    `удержаний: ${holds.length}`,
  );
  const resolveBody = JSON.stringify({ holdIds: holds.filter((h) => !h.covered).map((h) => h.id), resolution: 'not_applicable', reason: 'smoke: изменения не влияют на тестовый комплект' });
  const engResolve = await api2(`/release-candidates/${candidateId}/holds/resolve`, { method: 'POST', headers: { ...json, ...idem() }, body: resolveBody });
  const resolved = await api(`/release-candidates/${candidateId}/holds/resolve`, { method: 'POST', headers: { ...json, ...idem() }, body: resolveBody });
  c = await view();
  record(
    'этап 13: «не влияет» решает только руководитель (инженер 403); после решения удержаний нет, INPUTS_CHANGED снят, неснимаемые блокеры остались',
    engResolve.status === 403 &&
      resolved.status === 200 &&
      c.current === true &&
      !openBlockers(c.gate?.approve).some((b) => b.code === 'INPUTS_CHANGED') &&
      stable.length > 0 &&
      stable.every((code) => openBlockers(c.gate?.approve).some((b) => b.code === code)),
    `HTTP ${engResolve.status}/${resolved.status}`,
  );
  const history = await (await api(`/release-candidates/${candidateId}/history`)).json();
  record('этап 13: журнал комплекта — сборка и решения по событиям с автором и основанием', (history.items ?? []).some((e) => e.action === 'hold_not_applicable' && e.actor && e.basis));
  return { candidateId, hard: stable, holdsResolved: holds.length };
};
