// Шаги smoke этапа 10 (D-030): экономика на реальных server + worker. Расчёт — поддельный TenderHub (VERIFIED_FIXTURE):
// отчёт ревизии (суммы в RUB, сверка с итогом, составляющие «недоступно по ключу»); вторая выгрузка той же версии с
// изменённым итогом → вторая ревизия; сравнение одной транзакцией: пары по UUID подтверждает система (один экземпляр
// TENDERHUB_INSTANCE_ID, тендер, версия), остаток итога — отдельной строкой уровня тендера; повтор с тем же ключом — то же
// сравнение. Отказ не участнику (404) — в tests/economics.test.ts: в smoke нет пользователя вне демо-тендера.
// Вызывается из scripts/smoke.mjs.
export const smokeEconomics = async ({ api, record, waitFor, idem, json, stageId, hub, standardTender, TH }) => {
  const revs = (await (await api(`/stages/${stageId}/calculation-revisions`)).json()).items ?? [];
  const left = revs[0]?.id;
  const rep = await api(`/calculation-revisions/${left}/economics`);
  const report = rep.status === 200 ? await rep.json() : null;
  record(
    'этап 10: отчёт ревизии — суммы в RUB, НДС неизвестен, итог TenderHub — цель сверки, остаток не итог КП, 7 составляющих «недоступно по ключу», пересчёт строк',
    Boolean(report) &&
      report.totals.cost.currency === 'RUB' &&
      report.totals.cost.vat === 'unknown' &&
      report.reconciliation.targetKind === 'cached_grand_total' &&
      report.reconciliation.isKpTotal === false &&
      report.components.length === 7 &&
      report.components.every((c) => c.status === 'unavailable_by_key') &&
      report.lineCheck.lines > 0,
    report ? `сверка: ${report.reconciliation.status}, строк ${report.lineCheck.lines}` : `HTTP ${rep.status}`,
  );
  // Вторая выгрузка той же версии: изменился только итог источника.
  const changed = standardTender();
  changed.cached_grand_total = { __num: '1900.9' };
  hub.tenders.set(TH.tender, changed);
  const capReq = await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const cap = await capReq.json();
  const done = await waitFor(async () => {
    const c = await (await api(`/calculation-captures/${cap.id}`)).json();
    return c.status !== 'capturing' ? c : null;
  }, 60_000);
  const right = done?.revisionId;
  record('этап 10: вторая ревизия той же версии тендера (изменился итог источника)', done?.status === 'complete' && Boolean(right) && right !== left, done ? `статус ${done.status}` : 'нет результата');
  const key = idem();
  const create = () => api(`/stages/${stageId}/comparisons`, { method: 'POST', headers: { ...json, ...key }, body: JSON.stringify({ leftRevisionId: left, rightRevisionId: right }) });
  const c1 = await create();
  const cmp = c1.status === 201 ? await c1.json() : null;
  const c2 = await create();
  const replay = c2.status === 201 ? await c2.json() : null;
  const view = cmp ? await (await api(`/comparisons/${cmp.id}`)).json() : null;
  const remainder = view?.summary?.effects?.find((x) => x.measure === 'commercial' && x.level === 'tender' && x.component === 'unexplained_remainder')?.amount;
  record(
    'этап 10: сравнение готово одной транзакцией; пары по UUID подтверждены системой (экземпляр, тендер, версия); остаток итога +40 — строкой уровня тендера; повтор с ключом — то же сравнение',
    cmp?.status === 'ready' && cmp.proposals?.systemConfirmed === 3 && cmp.proposals?.proposed === 0 && remainder === '40' && replay?.id === cmp.id,
    cmp ? `систем. пар ${cmp.proposals?.systemConfirmed}, остаток ${remainder}` : `HTTP ${c1.status}`,
  );
  return { comparisonId: cmp?.id ?? null, resultSha256: view?.resultSha256 ?? null, secondRevision: done?.status === 'complete' && Boolean(right) };
};
