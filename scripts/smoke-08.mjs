// Шаги smoke этапа 08 (D-026): требования на реальных server + worker. Снимок области этапа (с письмом и Q&A
// этапа 07) закрепляется реестром; worker выполняет прогон поддельной модели (MODEL_PROVIDER=fake: живой модели
// на машине разработки нет), повтор возвращает тот же прогон; требование подтверждает руководитель; покрытие —
// комплексная расценка ревизии расчёта 06 (provisional, X-01 не снимается); полнота считается по фрагментам;
// инженер без mail.read видит требование из письма только оболочкой, а требование по документу с закрытым
// уточнением из письма — тоже оболочкой (R08-02); конфликт требований и несовпадение единиц покрытия —
// 409 без пояснения, запись с пояснением (R08-01). Вызывается из scripts/smoke.mjs.
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
  const candidate = async (statement, evidence, parameters = []) => {
    const r = await api(`/requirement-registries/${reg.id}/requirement-candidates`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ statement, evidence, parameters }) });
    return { id: (await r.json()).id, etag: r.headers.get('etag') };
  };
  const confirm = async (c, body = {}) => {
    const ok = await api(`/requirement-candidates/${c.id}/confirm`, { method: 'POST', headers: { ...json, 'If-Match': c.etag, ...idem() }, body: JSON.stringify(body) });
    return { status: ok.status, body: await ok.json() };
  };
  const propose = async (statement, fragmentId, parameters = []) => confirm(await candidate(statement, [{ fragmentId, role: 'supports' }], parameters));
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

  // R08-02: открытое основание документа + закрытое уточнение из письма — у инженера без mail.read оболочка.
  const mixed = await confirm(await candidate('smoke: требование с уточнением из письма', [{ fragmentId: await firstOf(docUnit), role: 'supports' }, { fragmentId: await firstOf(mailUnit), role: 'clarifies' }]));
  const mixedShell = await (await api2(`/requirements/${mixed.body.requirementId}`)).json();
  record(
    'этап 08: закрытое clarifies скрывает формулировку у инженера без mail.read (R08-02)',
    mixed.status === 200 && mixedShell.visible === false && mixedShell.statement === null && !JSON.stringify(mixedShell).includes('уточнением из письма'),
  );

  // R08-01: конфликт требований — подтверждение только с пояснением.
  const docFrag = await firstOf(docUnit);
  const b30 = await propose('smoke: класс бетона B30', docFrag, [{ name: 'Класс бетона', value: 'B30' }]);
  const b40 = await candidate('smoke: класс бетона B40', [{ fragmentId: docFrag, role: 'supports' }], [{ name: 'Класс бетона', value: 'B40' }]);
  const noNote = await confirm(b40);
  const withNote = await confirm(b40, { conflictNote: 'smoke: уточняется вопросом заказчику' });
  record(
    'этап 08: конфликт требований — 409 requirement_conflict без пояснения, подтверждение с пояснением (R08-01)',
    b30.status === 200 && noNote.status === 409 && noNote.body.current?.reason === 'requirement_conflict' && withNote.status === 200,
  );
  const conflictCard = await (await api(`/requirements/${withNote.body.requirementId}`)).json();
  const b30Card = await (await api(`/requirements/${b30.body.requirementId}`)).json();
  record(
    'этап 08: конфликт виден в карточках обоих требований кодом и параметром',
    conflictCard.conflicts?.[0]?.code === b30Card.code && conflictCard.conflicts?.[0]?.parameter === 'класс бетона' && b30Card.conflicts?.[0]?.code === conflictCard.code,
  );

  // R08-01: единица требования (м²) не совпадает с единицей позиции расчёта.
  const area = await propose('smoke: площадь утепления 120 м²', docFrag, [{ name: 'Площадь утепления', value: '120', unit: 'м²' }]);
  const covBodyOf = (extra) =>
    JSON.stringify({ state: 'covered', ...extra, objects: [{ type: 'calculation_revision', calculationRevisionId: calc.id, externalPositionId: pos.externalPositionId, match: 'complex_rate' }] });
  const unitBad = await api(`/requirement-revisions/${area.body.revisionId}/coverage`, { method: 'POST', headers: { ...json, ...idem() }, body: covBodyOf({}) });
  const unitBadBody = await unitBad.json();
  const unitOk = await api(`/requirement-revisions/${area.body.revisionId}/coverage`, { method: 'POST', headers: { ...json, ...idem() }, body: covBodyOf({ unitMismatchReason: 'smoke: пересчёт объёма в площадь' }) });
  const unitOkBody = await unitOk.json();
  record(
    'этап 08: несовпадение единиц — 409 unit_mismatch без пояснения, с пояснением — оценка с признаком (R08-01)',
    unitBad.status === 409 && unitBadBody.current?.reason === 'unit_mismatch' && unitOk.status === 201 && unitOkBody.coverageUnitMismatch === true,
    `требование ${unitBadBody.current?.objects?.[0]?.requirementUnits?.join(',') ?? '?'}, расчёт ${unitBadBody.current?.objects?.[0]?.calculationUnit ?? '?'}`,
  );
  return { requirementId: fromDoc.body.requirementId };
};
