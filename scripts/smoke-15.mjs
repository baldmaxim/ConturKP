// Шаги smoke этапа 15 (D-035): отправки и сравнение выпусков на настоящих server + worker. Комплект демо-этапа в smoke
// до выпуска не доходит (неснимаемые блокеры этапа 13), поэтому здесь проверяется то, что от выпуска не зависит:
// маршруты этапа подключены и закрыты правами, выпусков у тендера нет — сравнивать нечего, чужой и несуществующий выпуск
// не раскрываются, тело запроса проверяется, статус чтения отправленных писем MailHub — BLOCKED_EXTERNAL (X-03). Полный
// путь «боевой выпуск → письмо → регистрация → сверка вложений» и сравнение выпусков — интеграционные тесты
// tests/send*.test.ts, tests/releaseComparison.test.ts и проверка интерфейса artifacts/stage-15/ui-check.mjs (поддельные
// данные). Вызывается из scripts/smoke.mjs; после перезапуска server состояние читается там из PostgreSQL.
import { randomUUID } from 'node:crypto';

export const smokeSends = async ({ base, api, api2, record, idem, json, tenderId }) => {
  const post = (client, path, body) => client(path, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify(body) });
  const unknown = randomUUID();

  const releases = await api(`/tenders/${tenderId}/releases`);
  const releasesBody = releases.status === 200 ? await releases.json() : null;
  const comparisons = await api2(`/tenders/${tenderId}/release-comparisons`);
  const comparisonsBody = comparisons.status === 200 ? await comparisons.json() : null;
  record(
    'этап 15: выпуски тендера и сравнения читает участник; выпусков нет — сравнивать нечего',
    Array.isArray(releasesBody?.items) && releasesBody.items.length === 0 && releasesBody.canCompare === true && Array.isArray(comparisonsBody?.items) && comparisonsBody.items.length === 0,
    `HTTP ${releases.status}/${comparisons.status}`,
  );

  const same = await post(api2, `/tenders/${tenderId}/release-comparisons`, { leftReleaseId: unknown, rightReleaseId: unknown });
  const absent = await post(api2, `/tenders/${tenderId}/release-comparisons`, { leftReleaseId: unknown, rightReleaseId: randomUUID() });
  const foreignTender = await api2(`/tenders/${randomUUID()}/releases`);
  record(
    'этап 15: сравнение одного выпуска с собой и несуществующих выпусков — 400; чужой тендер — 404',
    same.status === 400 && absent.status === 400 && foreignTender.status === 404,
    `HTTP ${same.status}/${absent.status}/${foreignTender.status}`,
  );

  const sends = await api2(`/releases/${unknown}/send-events`);
  const candidates = await api2(`/releases/${unknown}/send-candidates`);
  const register = await post(api2, `/releases/${unknown}/send-events`, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: 'smoke: несуществующий выпуск' });
  const incident = await post(api2, `/releases/${unknown}/compliance-incidents`, { kind: 'other', occurredAt: new Date().toISOString(), description: 'smoke: несуществующий выпуск' });
  const evidence = await api2(`/send-events/${unknown}/evidence`);
  const item = await api2(`/release-comparison-items/${unknown}/reasons`);
  record(
    'этап 15: несуществующий выпуск, отправка и вывод сравнения не раскрываются — 404 у чтения, регистрации, нарушения и основания',
    [sends, candidates, register, incident, evidence, item].every((r) => r.status === 404),
    `HTTP ${[sends, candidates, register, incident, evidence, item].map((r) => r.status).join('/')}`,
  );

  const anonymous = await fetch(`${base}/api/v1/tenders/${tenderId}/releases`);
  record('этап 15: без сессии выпуски тендера не читаются — 401', anonymous.status === 401, `HTTP ${anonymous.status}`);

  // Статус чтения отправленных писем MailHub показывается вместе с интеграциями почты (раздел «Почта»).
  const boxes = await api('/mailboxes');
  const boxesBody = boxes.status === 200 ? await boxes.json() : null;
  const mailhub = (boxesBody?.integrations ?? []).filter((i) => i.system === 'mailhub');
  record(
    'этап 15: MailHub — чтение ящиков и отправленных писем BLOCKED_EXTERNAL (X-03); рабочей интеграцией не объявлено',
    mailhub.length >= 1 && mailhub.every((i) => i.status === 'BLOCKED_EXTERNAL') && mailhub.some((i) => i.component === 'MailHubSentReader'),
    mailhub.map((i) => `${i.component}=${i.status}`).join(', ') || `HTTP ${boxes.status}`,
  );
  return { tenderId };
};
