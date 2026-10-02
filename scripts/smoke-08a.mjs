// Шаги smoke этапа 08a (D-027): диалоги и ответное ядро на реальных server + worker. Модель — поддельная
// (MODEL_PROVIDER=fake: живой модели на машине разработки нет), поэтому проверяется ядро, а не качество ответа (Q-11).
// Вопрос — задание gpu; до завершения прогон отдаётся без текста (черновик не показывается и не стримится); ответ —
// с цитатами фрагментов области; второй вопрос до ответа на первый — 409; вопрос без оснований — не «подтверждено»;
// чужой участник тендера диалога и прогона не видит (404). Граф фактов D-018 (D-028): worker извлёк факты правилами,
// граф тендера посчитан; прогон кандидатов требований по правилам завершается без модели. Вызывается из scripts/smoke.mjs.
export const smokeAnswers = async ({ api, api2, record, waitFor, idem, json, tenderId, stageId }) => {
  const context = { kind: 'tender', tenderId, mode: 'working', stageId };
  const key = idem();
  const create = () => api('/dialogs', { method: 'POST', headers: { ...json, ...key }, body: JSON.stringify({ context, title: 'smoke: вопросы' }) });
  const d1 = await create();
  const dialog = await d1.json();
  const d2 = await (await create()).json();
  record('этап 08a: диалог создан в области этапа; повтор с тем же ключом — тот же диалог', d1.status === 201 && d2.id === dialog.id);

  const ask = (text) => api(`/dialogs/${dialog.id}/messages`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ text }) });
  const q1 = await ask('Какая гидроизоляция фундамента?');
  const q1Body = await q1.json();
  const early = await (await api(`/answer-runs/${q1Body.runId}`)).json();
  const busy = await ask('Какой срок?');
  const busyBody = await busy.json();
  record(
    'этап 08a: вопрос принят заданием; до ответа — только состояние без текста; второй вопрос — 409 answer_pending',
    q1.status === 201 && (early.status !== 'completed' ? early.answer === null : true) && busy.status === 409 && busyBody.current?.reason === 'answer_pending',
    `прогон ${early.status}`,
  );
  const done = await waitFor(async () => {
    const r = await (await api(`/answer-runs/${q1Body.runId}`)).json();
    return ['completed', 'failed'].includes(r.status) ? r : null;
  }, 60_000);
  record(
    'этап 08a: worker составил ответ поддельной моделью — подтверждено цитатами фрагментов области',
    done?.status === 'completed' && done.answerStatus === 'confirmed_by_citations' && done.answer?.citations?.length > 0 && done.answer.citations.every((c) => c.fragmentId && c.text),
    done ? `${done.answerStatus}, цитат ${done.answer?.citations?.length ?? 0}, модель ${done.model?.provider ?? '—'}` : 'нет итога',
  );

  const q2 = await (await ask('Какой цвет облицовки кровли павильона?')).json();
  const none = await waitFor(async () => {
    const r = await (await api(`/answer-runs/${q2.runId}`)).json();
    return ['completed', 'failed'].includes(r.status) ? r : null;
  }, 60_000);
  record(
    'этап 08a: вопрос без оснований — не «подтверждено цитатами», утверждений без цитат нет',
    none?.status === 'completed' && none.answerStatus !== 'confirmed_by_citations' && (none.answer?.shownClaims ?? 0) === 0,
    none ? `${none.answerStatus}${none.incompleteReason ? ` (${none.incompleteReason})` : ''}` : 'нет итога',
  );

  const foreignDialog = await api2(`/dialogs/${dialog.id}`);
  const foreignRun = await api2(`/answer-runs/${q1Body.runId}`);
  const foreignList = await (await api2(`/dialogs?stageId=${stageId}`)).json();
  record(
    'этап 08a: другой участник тендера — 404 на диалог и прогон, в его списке диалога нет',
    foreignDialog.status === 404 && foreignRun.status === 404 && !foreignList.items?.some((x) => x.id === dialog.id),
  );
  const graph = await waitFor(async () => {
    const r = await api(`/tenders/${tenderId}/fact-graph`);
    const b = r.status === 200 ? await r.json() : null;
    return b?.graphHash ? b : null;
  }, 60_000);
  record(
    'этап 08a: граф фактов D-018 — worker извлёк факты правилами, граф тендера посчитан',
    Boolean(graph) && graph.documents.length > 0,
    graph ? `документов ${graph.documents.length}, фактов ${graph.facts.length}, замечаний ${graph.remarks.length}` : 'нет графа',
  );
  const view = await (await api(`/stages/${stageId}/requirement-registry`)).json();
  const rules = await api(`/requirement-registries/${view.active.id}/analysis-runs`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ task: 'requirement_extraction', method: 'rules' }) });
  const rulesRun = await rules.json();
  const rulesDone = await waitFor(async () => {
    const r = await (await api(`/analysis-runs/${rulesRun.id}`)).json();
    return ['completed', 'failed'].includes(r.status) ? r : null;
  }, 60_000);
  record(
    'этап 08a: кандидаты требований по правилам — прогон rules без модели завершён',
    rules.status === 201 && rulesDone?.status === 'completed' && rulesDone.providerId === 'rules',
    rulesDone ? `кандидатов ${rulesDone.coverage?.candidatesSaved ?? 0}` : 'нет итога',
  );
  return { dialogId: dialog.id };
};
