// Шаги smoke этапа 08 (D-026): требования на реальных server + worker. Снимок области этапа (с письмом и Q&A
// этапа 07) закрепляется реестром; worker выполняет прогон поддельной модели (MODEL_PROVIDER=fake: живой модели
// на машине разработки нет), повтор возвращает тот же прогон; требование подтверждает руководитель; покрытие —
// комплексная расценка ревизии расчёта 06 (provisional, X-01 не снимается); полнота считается по фрагментам;
// инженер без mail.read видит требование из письма только оболочкой. Вызывается из scripts/smoke.mjs.
export const smokeRequirements = async ({ api, api2, record, waitFor, idem, json, stageId }) => {
  const scopeRes = await api(`/stages/${stageId}/evidence-scopes`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const scope = await scopeRes.json();
  record(
    'этап 08: снимок области этапа включает письмо и вопрос–ответ (Р-08-1)',
    [200, 201].includes(scopeRes.status) && scope.items?.some((i) => i.unitType === 'qa_item_revision') && scope.items?.some((i) => i.unitType === 'mail_message'),
  );
  const regRes = await api(`/stages/${stageId}/requirement-registries`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ evidenceScopeId: scope.id, reason: 'smoke: реестр этапа' }) });
  const reg = await regRes.json();
  record('этап 08: реестр требований закреплён на снимке и активен', regRes.status === 201 && reg.active === true && reg.evidenceScopeId === scope.id);
  const start = () => api(`/requirement-registries/${reg.id}/analysis-runs`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ task: 'requirement_extraction' }) });
  const runRes = await start();
  const run = await runRes.json();
  const done = await waitFor(async () => {
    const r = await (await api(`/analysis-runs/${run.id}`)).json();
    return ['completed', 'completed_with_gaps', 'failed'].includes(r.status) ? r : null;
  }, 60_000);
  record(
    'этап 08: worker выполнил прогон поддельной модели по зафиксированному снимку',
    runRes.status === 201 && done?.status === 'completed' && done.providerId === 'fake',
    done ? `фрагментов ${done.inputCount}, кандидатов ${done.coverage?.candidatesSaved}` : 'нет итога',
  );
  const again = await (await start()).json();
  record('этап 08: повтор с теми же входами — тот же прогон', again.reused === true && again.id === run.id);
  const comp = await (await api(`/requirement-registries/${reg.id}/completeness`)).json();
  const mailUnit = comp.units?.find((u) => u.unitType === 'mail_message');
  const docUnit = comp.units?.find((u) => u.unitType === 'document_recognition' && u.total > 0);
  const firstOf = async (unit) => (await (await api(`/requirement-registries/${reg.id}/fragments?scopeItemId=${unit.scopeItemId}`)).json()).items?.[0]?.fragmentId;
  const propose = async (statement, fragmentId) => {
    const r = await api(`/requirement-registries/${reg.id}/requirement-candidates`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ statement, evidence: [{ fragmentId, role: 'supports' }] }) });
    const c = await r.json();
    const ok = await api(`/requirement-candidates/${c.id}/confirm`, { method: 'POST', headers: { ...json, 'If-Match': r.headers.get('etag'), ...idem() }, body: '{}' });
    return { status: ok.status, body: await ok.json() };
  };
  const fromDoc = await propose('smoke: требование по документу этапа', await firstOf(docUnit));
  const fromMail = await propose('smoke: требование по письму заказчика', await firstOf(mailUnit));
  record('этап 08: кандидаты подтверждены руководителем — требования с кодами', fromDoc.status === 200 && fromMail.status === 200);
  const revs = await (await api(`/stages/${stageId}/calculation-revisions`)).json();
  const calc = revs.items?.[0];
  const positions = await (await api(`/calculation-revisions/${calc.id}/positions`)).json();
  const pos = positions.items?.find((p) => !p.isSection);
  const cov = await api(`/requirement-revisions/${fromDoc.body.revisionId}/coverage`, {
    method: 'POST',
    headers: { ...json, ...idem() },
    body: JSON.stringify({ state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc.id, externalPositionId: pos.externalPositionId, match: 'complex_rate' }] }),
  });
  const covBody = await cov.json();
  record(
    'этап 08: покрытие комплексной расценкой ревизии расчёта (A05); ревизия provisional — X-01 остаётся',
    cov.status === 201 && covBody.coverageState === 'covered' && calc.kind === 'provisional',
  );
  const counts = (await (await api(`/requirement-registries/${reg.id}/completeness`)).json()).counts;
  record(
    'этап 08: полнота по фрагментам — total = reviewed + not_requirement + unreviewed; завершение без просмотра невозможно',
    counts.total_units === counts.reviewed_units + counts.explicit_not_requirement_units + counts.unreviewed_units &&
      (await api(`/requirement-registries/${reg.id}/reviews`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' })).status === 409,
    `фрагментов ${counts.total_units}, не просмотрено ${counts.unreviewed_units}`,
  );
  const shell = await (await api2(`/requirements/${fromMail.body.requirementId}`)).json();
  const open = await (await api2(`/requirements/${fromDoc.body.requirementId}`)).json();
  record(
    'этап 08: инженер без mail.read — требование из письма оболочкой без текста; из документа — целиком (Р-08-5)',
    shell.visible === false && shell.statement === null && open.visible === true && open.statement === 'smoke: требование по документу этапа',
  );
  return { requirementId: fromDoc.body.requirementId };
};
