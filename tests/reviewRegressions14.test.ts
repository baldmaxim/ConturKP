// Регрессии Review 14-1 на настоящей БД и worker (сценарии ревью). R14-01: в выпуске принят риск по замечанию с
// основанием из закрытого письма; инженер 2 видит комплект, но не письмо и не причину риска — манифест выпуска ему
// закрыт (409). Внутренний набор назначения содержит манифест выпуска — разместить его может только тот, кто сейчас
// читает манифест: при выпуске, «Разместить», повторе и перенаправлении; worker перед записью перепроверяет текущие
// права того, кто запросил размещение. R14-03 — через «Проверить назначение» и задание размещения. На передаче 14-1
// (`8c6cb90`) сценарии падают.
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { acceptAll, acceptRisk, approve, assembled, buildStage13, closeStage13, notApplicable, release, view, type IStage13 } from './approvalFixtures.ts';
import {
  act,
  createDestination,
  deliveriesOf,
  deliveryOf,
  deliveryWorker,
  destination,
  FaultyFs,
  place,
  runDeliveries,
  tempFolders,
  tree,
  type IDeliveryView,
  type IDestinationView,
  type IFolders,
} from './deliveryFixtures.ts';
import { auditRows, idem } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { fixScope } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SECRET = 'SYNTHETIC-R14: причина риска по закрытому письму';

let st: IStage13;
let folders: IFolders;
let box = '';
let releaseId = '';
let customer: IDestinationView;
let internal: IDestinationView;
const fs = new FaultyFs();

const s = () => st.e.s;
const files = (root: string) => (existsSync(root) ? [...tree(root).keys()] : []);
const manifestsIn = (root: string) => files(root).filter((p) => p.endsWith('release-manifest.json'));
const secretIn = (root: string) => [...(existsSync(root) ? tree(root).values() : [])].some((b) => b.toString('utf8').includes(SECRET));
const allOf = async (destId: string): Promise<IDeliveryView | undefined> =>
  (await deliveriesOf(s().manager, releaseId)).items.find((d) => d.destination.id === destId && d.status !== 'superseded');

beforeAll(async () => {
  st = await buildStage13();
  folders = tempFolders();
  box = await createMailbox(s().admin, 'r14@example.test', 'Ящик R14');
  for (const id of [s().ids.eng1, s().ids.manager]) await setMailAccess(s().admin, box, id, ['mail.read', 'mail.import', 'mail.link']);
  const mail = await importEml(s().eng1, st.e.worker, box, eml({ messageId: 'r14@example.test', subject: 'Закрытое условие', text: SECRET }));
  await linkMail(s().eng1, mail.messageId!, s().tenderA, s().stageA);
  await fixScope(s().manager, s().stageA);
  const fragment = (await st.db.pool.query("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [mail.revisionId])).rows[0].id;
  const f = await s().eng1.post(`/stages/${s().stageA}/findings`, { title: SECRET, severity: 'critical', confidence: 'high', evidence: [{ side: 'left', fragmentId: fragment }] }, { headers: idem() });
  expect(f.status, f.text).toBe(201);
  let c = await assembled(st);
  await notApplicable(st, c.id, 'Письмо не меняет выбранные документы');
  expect((await acceptRisk(st, c, { blockerCode: 'CRITICAL_FINDINGS_OPEN', subjectType: 'finding', subjectId: f.body.id, reason: SECRET })).status).toBe(201);
  await acceptAll(st, await view(st, c.id));
  c = await view(st, c.id);
  const a = await approve(st, c);
  expect(a.status, a.text).toBe(200);
  // Назначения заводятся до выпуска: доставки создаются в транзакции выпуска.
  customer = await createDestination(s().admin, { title: 'Для заказчика', kind: 'smb', rootPath: folders.smbRoot });
  const internalRoot = join(folders.base, 'internal', 'Контур');
  mkdirSync(internalRoot, { recursive: true });
  internal = await createDestination(s().admin, { title: 'Внутреннее', kind: 'smb', rootPath: internalRoot, includeInternal: true });
  // Выпускает инженер 2: комплект он видит, письмо — нет.
  const r = await release(st, await view(st, c.id, s().eng2), a.body.approval.id as string, { client: s().eng2 });
  expect(r.status, r.text).toBe(201);
  releaseId = r.body.release.id as string;
});
afterAll(async () => {
  await closeStage13(st);
});

describe('R14-01: внутренний манифест выпуска не выгружается в обход права на его основания', () => {
  it('контроль этапа 13: инженер 2 не скачивает манифест выпуска и ZIP всех файлов (409)', async () => {
    expect((await s().eng2.get(`/releases/${releaseId}/manifest`)).status).toBe(409);
    expect((await s().eng2.get(`/releases/${releaseId}/archive?set=all`)).status).toBe(409);
    expect((await s().manager.get(`/releases/${releaseId}/manifest`)).status).toBe(200);
  });

  it('выпуск инженером 2: доставка «для заказчика» создана, во внутреннее назначение — нет; ничего закрытого не записано', async () => {
    await runDeliveries(st, deliveryWorker(st, fs));
    const list = await deliveriesOf(s().manager, releaseId);
    expect(list.items.map((d) => d.destination.id)).toEqual([customer.id]);
    expect(list.items[0]!.status).toBe('delivered');
    expect(manifestsIn(internal.current.rootPath)).toEqual([]);
    expect(secretIn(internal.current.rootPath)).toBe(false);
    const audit = await auditRows(st.db.pool, "action = 'release.create' AND entity_id = $1", [releaseId]);
    expect((audit[0]!.details as { deliveriesSkipped?: { destinationId: string; reason: string }[] }).deliveriesSkipped).toEqual([{ destinationId: internal.id, reason: 'restricted_basis' }]);
  });

  it('«Разместить» инженером 2 во внутреннее назначение — 409 restricted_basis, ничего не записано; видит, что недоступно', async () => {
    const view2 = await deliveriesOf(s().eng2, releaseId);
    expect(view2.canPlace).toBe(false);
    expect(view2.summary).toMatchObject({ missing: 0, restricted: 1 });
    const r = await place(s().eng2, releaseId, 'Попытка выгрузить закрытый манифест');
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('restricted_basis');
    await runDeliveries(st, deliveryWorker(st, fs));
    expect(await allOf(internal.id)).toBeUndefined();
    expect(manifestsIn(internal.current.rootPath)).toEqual([]);
  });

  it('права отозваны между заказом и выполнением: worker отказывает RESTRICTED_BASIS до записи; повтор без прав — 409, с правами — размещено', async () => {
    const r = await place(s().manager, releaseId, 'Внутренний набор для отдела');
    expect(r.status, r.text).toBe(201);
    await setMailAccess(s().admin, box, s().ids.manager, []);
    await runDeliveries(st, deliveryWorker(st, fs));
    let d = (await allOf(internal.id))!;
    expect(d).toMatchObject({ status: 'failed', fileSet: 'all', lastError: { code: 'RESTRICTED_BASIS' } });
    expect(d.attempts).toHaveLength(1);
    expect(files(internal.current.rootPath).filter((p) => !p.startsWith('.kontur-staging'))).toEqual([]);
    // Инженер 2 повторить не может; действие ему не предлагается.
    expect((await deliveryOf(s().eng2, d.id)).actions.retry).toBe(false);
    expect((await act(s().eng2, d, 'retry', 'Повтор без права на основания')).body.current.reason).toBe('restricted_basis');
    // Доступ возвращён — руководитель повторяет, набор размещён целиком.
    await setMailAccess(s().admin, box, s().ids.manager, ['mail.read', 'mail.import', 'mail.link']);
    d = (await allOf(internal.id))!;
    expect((await act(s().manager, d, 'retry', 'Доступ к ящику восстановлен')).status).toBe(200);
    await runDeliveries(st, deliveryWorker(st, fs));
    d = (await allOf(internal.id))!;
    expect(d.status).toBe('delivered');
    expect(manifestsIn(internal.current.rootPath)).toHaveLength(1);
  });

  it('перенаправление на внутреннюю версию назначения — та же проверка права', async () => {
    const third = join(folders.base, 'third');
    mkdirSync(third);
    const d3 = await createDestination(s().admin, { title: 'Третье', kind: 'smb', rootPath: third });
    const p = await place(s().manager, releaseId, 'Третье назначение');
    expect(p.status, p.text).toBe(201);
    fs.add({ op: 'mkdir', path: third, effect: { errno: 'EACCES' } });
    fs.add({ op: 'writeFile', path: third, effect: { errno: 'EACCES' } });
    await runDeliveries(st, deliveryWorker(st, fs));
    fs.clear();
    const failed = (await allOf(d3.id))!;
    expect(failed).toMatchObject({ status: 'failed', fileSet: 'customer' });
    const cur = await destination(s().admin, d3.id);
    const root3 = join(folders.base, 'third-v2');
    mkdirSync(root3);
    const v = await s().admin.post(`/delivery-destinations/${d3.id}/versions`, { rootPath: root3, includeInternal: true, reason: 'Папка отдела с внутренними материалами' }, { headers: { 'If-Match': cur.etag, ...idem() } });
    expect(v.status, v.text).toBe(201);
    const f2 = await deliveryOf(s().eng2, failed.id);
    expect(f2.actions.redirect).toBe(false);
    expect((await act(s().eng2, f2, 'redirect', 'Перенаправить во внутреннюю версию')).body.current.reason).toBe('restricted_basis');
    const fm = await deliveryOf(s().manager, failed.id);
    expect(fm.actions.redirect).toBe(true);
    expect((await act(s().manager, fm, 'redirect', 'Перенаправить во внутреннюю версию')).status).toBe(201);
    await runDeliveries(st, deliveryWorker(st, fs));
    expect((await allOf(d3.id))!).toMatchObject({ status: 'delivered', fileSet: 'all' });
    expect(manifestsIn(root3)).toHaveLength(1);
  });
});

describe('R14-03: служебная папка Яндекс Диска физически внутри синхронизации — через API и worker', () => {
  it('«Проверить назначение» и размещение отказывают INVALID_PATH, внутри синхронизации ничего не записано', async () => {
    const base = join(folders.base, 'junction');
    const root = join(base, 'Яндекс.Диск', 'Контур');
    const physical = join(root, 'служебная');
    mkdirSync(physical, { recursive: true });
    const alias = join(base, 'служебная-ссылка');
    symlinkSync(physical, alias, 'junction');
    const y = await createDestination(s().admin, { title: 'Яндекс Диск через ссылку', kind: 'yandex_disk', rootPath: root, stagingPath: alias });
    const pr = await s().admin.post(`/delivery-destinations/${y.id}/probe`, {}, { headers: idem() });
    expect(pr.status, pr.text).toBe(202);
    await runDeliveries(st, deliveryWorker(st, fs));
    expect((await destination(s().admin, y.id)).lastProbe).toMatchObject({ outcome: 'failed', errorCode: 'INVALID_PATH' });
    const p = await place(s().manager, releaseId, 'Яндекс Диск через ссылку');
    expect(p.status, p.text).toBe(201);
    await runDeliveries(st, deliveryWorker(st, fs));
    expect((await allOf(y.id))!).toMatchObject({ status: 'failed', lastError: { code: 'INVALID_PATH' } });
    expect(readdirSync(physical)).toEqual([]);
    expect(readdirSync(root)).toEqual(['служебная']);
  });
});
