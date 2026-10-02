// Шаги smoke этапа 09 (D-029): проверка этапа и разногласия на реальных server + worker. Модель — поддельная
// (MODEL_PROVIDER=fake), расчёт — поддельный TenderHub: проверяется механизм, а не качество (В-09-5). Прогон закрепляет
// входы, worker выполняет программные проверки и гипотезы, отчёт не даёт «замечаний нет» из неполного прогона;
// инженер не принимает риск и не меняет приоритет источников (403). Вызывается из scripts/smoke.mjs.
export const smokeReview = async ({ api, api2, record, waitFor, idem, json, stageId, tenderId }) => {
  const key = idem();
  const start = () => api(`/stages/${stageId}/review-runs`, { method: 'POST', headers: { ...json, ...key }, body: '{}' });
  const r1 = await start();
  const run = await r1.json();
  const r2 = await (await start()).json();
  record('этап 09: прогон проверки создан на закреплённых входах; повтор с тем же ключом — тот же прогон', r1.status === 201 && r2.id === run.id, `статус ${run.status}`);
  const done = await waitFor(async () => {
    const r = await (await api(`/review-runs/${run.id}`)).json();
    return ['completed', 'completed_with_gaps', 'failed'].includes(r.status) ? r : null;
  }, 90_000);
  const gaps = done?.checks?.filter((c) => c.outcome === 'incomplete' || c.outcome === 'error').length ?? -1;
  record(
    'этап 09: worker выполнил 12 проверок (11 правил + гипотезы модели); итог согласован с исходами, «замечаний нет» без пробелов не выдаётся',
    Boolean(done) &&
      done.status !== 'failed' &&
      done.checks.length === 12 &&
      done.checks.every((c) => c.outcome !== null) &&
      (done.status === 'completed') === (gaps === 0) &&
      (done.summary.kind !== 'clean' || done.status === 'completed'),
    done ? `${done.status}, пробелов ${gaps}, сводка: ${done.summary.text}` : 'нет итога',
  );
  const list = await api(`/stages/${stageId}/findings`);
  const findings = list.status === 200 ? (await list.json()).items : [];
  record('этап 09: замечания этапа читаются; у каждого — вид, критичность и статус', list.status === 200 && findings.every((f) => f.kind && f.severity && f.status), `замечаний ${findings.length}`);
  const acceptable = findings.find((f) => f.riskAcceptable && f.status === 'open');
  let risk = null;
  if (acceptable) {
    risk = await api2(`/findings/${acceptable.id}/transitions`, {
      method: 'POST',
      headers: { ...json, ...idem(), 'If-Match': acceptable.etag },
      body: JSON.stringify({ to: 'accepted_risk', reason: 'smoke', statement: 'smoke' }),
    });
  }
  const kinds = ['tz', 'contract', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'];
  const priority = await api2(`/tenders/${tenderId}/source-priority`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ kinds, reason: 'smoke' }) });
  const view = await (await api2(`/tenders/${tenderId}/source-priority`)).json();
  record(
    'этап 09: инженер не принимает риск и не меняет приоритет источников (403); приоритет — порядок по умолчанию',
    (risk === null || risk.status === 403) && priority.status === 403 && view.isDefault === true && view.kinds[0]?.kind === 'contract',
    `риск ${risk?.status ?? 'нет кандидата'}, приоритет ${priority.status}`,
  );
  return { runId: run.id, status: done?.status ?? null };
};
