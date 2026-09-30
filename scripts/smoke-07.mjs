// Шаги smoke этапа 07 (D-025): почта, вопросы–ответы и переговоры на реальных server + worker. Ящик
// регистрирует администратор ящиков, письмо EML импортируется в ящик и разбирается worker, вложение CSV
// распознаётся общим путём 05a, связь с тендером подтверждается при импорте, поиск этапа находит письмо.
// Пользователь без выдачи по ящику не видит ни письма, ни фрагмента. Вызывается из scripts/smoke.mjs.
import { eml, negotiationManifest, qaManifest } from '../tests/mailFixtures.ts';

const MARKER = 'СМОУК-ГИДРО-7731';

export const smokeMail = async ({ api, api2, search, record, waitFor, idem, octet, json, tenderId, stageId, meId }) => {
  const box = await api('/mailboxes', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ system: 'manual', externalAccountId: 'smoke@contractor.example.test', displayName: 'Smoke' }) });
  const boxBody = await box.json();
  const card = await api(`/mailboxes/${boxBody.id}`);
  const grant = await api(`/mailboxes/${boxBody.id}/access/${meId}`, {
    method: 'PUT',
    headers: { ...json, 'If-Match': card.headers.get('etag') },
    body: JSON.stringify({ capabilities: ['mail.read', 'mail.import', 'mail.link'] }),
  });
  const list = await (await api('/mailboxes')).json();
  record(
    'этап 07: ящик зарегистрирован, выдача сохранена; MailHub и переговоры — BLOCKED_EXTERNAL',
    box.status === 201 && grant.status === 200 &&
      list.integrations?.some((i) => i.system === 'mailhub' && i.status === 'BLOCKED_EXTERNAL' && i.blockedBy === 'X-03') &&
      list.integrations?.some((i) => i.system === 'negotiations' && i.status === 'BLOCKED_EXTERNAL' && i.blockedBy === 'Q-06'),
  );
  const raw = eml({
    messageId: 'smoke-07@customer.example.test',
    subject: 'Гидроизоляция фундамента',
    text: `Согласуем ${MARKER}: обмазочная гидроизоляция.\n\n> Ранее предлагали мастику.`,
    attachments: [{ name: 'ведомость.csv', type: 'text/csv', bytes: Buffer.from('Позиция;Количество\nГидроизоляция;120\n', 'utf8') }],
  });
  const post = () =>
    api(`/mailboxes/${boxBody.id}/imports?${new URLSearchParams({ name: 'smoke.eml', tenderId, stageId }).toString()}`, { method: 'POST', headers: { ...octet, ...idem() }, body: raw });
  const imp = await post();
  const impBody = await imp.json();
  const done = await waitFor(async () => {
    const r = await (await api(`/mail-imports/${impBody.id}`)).json();
    return r.status === 'queued' ? null : r;
  }, 30_000);
  const message = done?.messageId ? await (await api(`/mail-messages/${done.messageId}`)).json() : null;
  record(
    'этап 07: EML разобран worker — письмо, цитата отдельным блоком, вложение-документ, связь с этапом',
    imp.status === 202 && done?.status === 'done' && done.createdRevision === true &&
      message?.current.body.some((b) => b.quoted) && message.current.attachments[0]?.status === 'registered' &&
      message.tenderLinks.some((l) => l.tenderId === tenderId && l.stageId === stageId),
  );
  const again = await post();
  const againBody = await again.json();
  const redo = await waitFor(async () => {
    const r = await (await api(`/mail-imports/${againBody.id}`)).json();
    return r.status === 'queued' ? null : r;
  }, 30_000);
  record('этап 07: повтор того же EML — прежняя ревизия, новой нет', redo?.status === 'done' && redo.createdRevision === false && redo.revisionId === done?.revisionId);
  const att = await waitFor(async () => {
    const m = await (await api(`/mail-messages/${done.messageId}`)).json();
    return m.current.attachments[0]?.runStatus === 'complete' ? m.current.attachments[0] : null;
  }, 60_000);
  record('этап 07: вложение CSV распознано общим путём 05a (автопроход worker)', Boolean(att));
  const hit = await waitFor(async () => {
    const r = await search({ context: { kind: 'tender', tenderId, mode: 'working', stageId }, query: MARKER, limit: 5 });
    if (r.status !== 200) return null;
    const b = await r.json();
    return (b.fused?.items ?? []).find((h) => h.text.includes(MARKER)) ?? null;
  }, 60_000);
  record('этап 07: поиск этапа находит письмо — источник «ревизия письма», шапка письма', hit?.sourceKind === 'mail_message_revision' && hit.mail?.messageId === done?.messageId);
  const qa = qaManifest([{ no: '1', question: 'Допускается ли бетон B30?', answer: 'Допускается.' }]);
  const qaPost = () => api(`/tenders/${tenderId}/qa-imports?name=qa.json&stageId=${stageId}`, { method: 'POST', headers: { ...octet, ...idem() }, body: Buffer.from(JSON.stringify(qa)) });
  const qa1 = await qaPost();
  const qa2 = await qaPost();
  record('этап 07: вопросы–ответы импортированы; повтор файла идемпотентен', qa1.status === 201 && qa2.status === 200 && (await qa2.json()).reused === true);
  const neg = negotiationManifest('r1', [
    { no: 1, speaker: 'S1', text: 'Мы рассмотрим снижение цены на пять процентов.' },
    { no: 2, speaker: 'S2', kind: 'hint', text: 'СМОУК-ПОДСКАЗКА уточнить срок оплаты.' },
  ]);
  const n1 = await api(`/tenders/${tenderId}/negotiation-imports?name=n.json`, { method: 'POST', headers: { ...octet, ...idem() }, body: Buffer.from(JSON.stringify(neg)) });
  const n1Body = await n1.json();
  const session = await (await api(`/negotiation-sessions/${n1Body.sessionId}`)).json();
  const speech = await waitFor(async () => {
    const r = await search({ context: { kind: 'tender', tenderId, mode: 'working', stageId }, query: 'рассмотрим снижение цены', limit: 5 });
    const b = r.status === 200 ? await r.json() : null;
    return (b?.fused?.items ?? []).find((h) => h.sourceKind === 'transcript_revision') ?? null;
  }, 60_000);
  const hint = await (await search({ context: { kind: 'tender', tenderId, mode: 'working', stageId }, query: 'СМОУК-ПОДСКАЗКА', limit: 5 })).json();
  record(
    'этап 07: переговоры — речь находится поиском, подсказка участнику в поиск не попадает',
    n1.status === 201 && session.segments?.map((x) => x.kind).join(',') === 'speech,hint' && Boolean(speech) &&
      (hint.fused?.items ?? []).every((h) => !h.text.includes('СМОУК-ПОДСКАЗКА')),
  );
  const hiddenMsg = await api2(`/mail-messages/${done?.messageId}`);
  const hiddenList = await (await api2(`/tenders/${tenderId}/mail-messages`)).json();
  const hiddenEvidence = hit ? await api2(`/evidence/${hit.fragmentId}`) : { status: 0 };
  const hiddenSearch = await (await api2('/search', { method: 'POST', headers: json, body: JSON.stringify({ context: { kind: 'tender', tenderId, mode: 'working', stageId }, query: MARKER }) })).json();
  record(
    'этап 07: участник тендера без mail.read — письмо и цитата 404, переписка пуста, поиск исключает письмо числом',
    hiddenMsg.status === 404 && hiddenList.items?.length === 0 && hiddenEvidence.status === 404 &&
      (hiddenSearch.fused?.items ?? []).every((h) => !h.text.includes(MARKER)) && hiddenSearch.scope?.excludedByAcl > 0,
  );
  const upEml = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('письмо.eml')}`, { method: 'POST', headers: { ...octet, ...idem() }, body: raw });
  const upBody = await upEml.json();
  const batch = await waitFor(async () => {
    const b = await (await api(`/imports/${upBody.id}`)).json();
    return b.items?.[0] && b.items[0].status !== 'pending' ? b : null;
  }, 30_000);
  record('этап 07: .eml в общем импорте источников — отказ элемента с пояснением', batch?.items?.[0]?.status === 'rejected' && batch.items[0].rejectReason === 'type_not_allowed');
};
