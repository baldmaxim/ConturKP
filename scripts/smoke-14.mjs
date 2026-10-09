// Шаги smoke этапа 14 (D-034): назначения размещения на настоящих server + worker во временных папках (поддельные
// назначения, не живая проверка). Администратор заводит «Яндекс Диск» (папка внутри «папки синхронизации» и служебная
// вне её) и сетевую папку; инженеру назначения недоступны. «Проверить назначение» выполняет worker под своей учётной
// записью: запись, перенос и удаление пробной папки; отсутствующая служебная папка — понятный отказ. Алгоритм размещения
// проверяется сценарием живой проверки в режиме --fixture (тот же адаптер и placeFolder, что у worker). Полный путь
// «выпуск → доставки → размещение» — интеграционные тесты tests/delivery*.test.ts: комплект демо-этапа в smoke до
// выпуска не доходит (неснимаемые блокеры этапа 13). Вызывается из scripts/smoke.mjs; после перезапуска server
// назначения и результаты проверки читаются там из PostgreSQL.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const smokeDelivery = async ({ root, env, api, api2, record, waitFor, idem, json }) => {
  const base = mkdtempSync(join(tmpdir(), 'kontur-smoke-delivery-'));
  const sync = join(base, 'Яндекс.Диск', 'Контур КП тест');
  const staging = join(base, 'kontur-staging');
  const share = join(base, 'share', 'Контур КП тест');
  for (const d of [sync, staging, share]) mkdirSync(d, { recursive: true });
  const post = (client, path, body, headers = {}) => client(path, { method: 'POST', headers: { ...json, ...idem(), ...headers }, body: JSON.stringify(body) });
  const list = async () => (await (await api('/delivery-destinations')).json()).items ?? [];
  const probe = async (id) => {
    const r = await post(api, `/delivery-destinations/${id}/probe`, {});
    const done = await waitFor(async () => {
      const d = (await list()).find((x) => x.id === id);
      return d && !d.probePending && d.lastProbe && d.lastProbe.current ? d : null;
    }, 30_000);
    return { status: r.status, d: done };
  };

  const y = await post(api, '/delivery-destinations', { title: 'Яндекс Диск (smoke)', kind: 'yandex_disk', environment: 'test', rootPath: sync, stagingPath: staging, reason: 'smoke: тестовое назначение' });
  const m = await post(api, '/delivery-destinations', { title: 'Сетевая папка (smoke)', kind: 'smb', environment: 'test', rootPath: share, reason: 'smoke: тестовое назначение' });
  const yBody = y.status === 201 ? await y.json() : null;
  const mBody = m.status === 201 ? await m.json() : null;
  const engList = await api2('/delivery-destinations');
  const engCreate = await post(api2, '/delivery-destinations', { title: 'x', kind: 'smb', environment: 'test', rootPath: share, reason: 'smoke: попытка инженера' });
  const inside = await post(api, '/delivery-destinations', { title: 'внутри', kind: 'yandex_disk', environment: 'test', rootPath: sync, stagingPath: join(sync, 'служебная'), reason: 'smoke: служебная внутри синхронизации' });
  record(
    'этап 14: назначения заводит администратор (инженеру 403); у Яндекс Диска служебная папка вне папки синхронизации (иначе 400); у сетевой — по умолчанию .kontur-staging',
    Boolean(yBody && mBody) && engList.status === 403 && engCreate.status === 403 && inside.status === 400 && mBody?.current?.stagingPath?.endsWith('.kontur-staging'),
    `HTTP ${y.status}/${m.status}/${engList.status}/${engCreate.status}/${inside.status}`,
  );
  if (!yBody || !mBody) return { destinationIds: [] };

  const py = await probe(yBody.id);
  const pm = await probe(mBody.id);
  const leftovers = [...readdirSync(sync), ...readdirSync(staging), ...readdirSync(share)].filter((n) => n.startsWith('.kontur-probe-'));
  record(
    'этап 14: «Проверить назначение» выполняет worker под своей учётной записью — запись, перенос и удаление пробной папки; пробных папок не осталось',
    py.status === 202 && py.d?.lastProbe?.outcome === 'ok' && pm.d?.lastProbe?.outcome === 'ok' && leftovers.length === 0 && existsSync(join(share, '.kontur-staging')),
    `${py.d?.lastProbe?.outcome ?? '—'}/${pm.d?.lastProbe?.outcome ?? '—'}`,
  );

  // Новая версия путей с отсутствующей служебной папкой — понятный отказ проверки; затем исправленная версия.
  const cur = (await list()).find((x) => x.id === yBody.id);
  const v2 = await post(api, `/delivery-destinations/${yBody.id}/versions`, { rootPath: sync, stagingPath: join(base, 'нет-такой-папки'), includeInternal: false, reason: 'smoke: опечатка в служебной папке' }, { 'If-Match': cur.etag });
  const bad = await probe(yBody.id);
  const cur2 = (await list()).find((x) => x.id === yBody.id);
  const v3 = await post(api, `/delivery-destinations/${yBody.id}/versions`, { rootPath: sync, stagingPath: staging, includeInternal: false, reason: 'smoke: исправлена служебная папка' }, { 'If-Match': cur2.etag });
  const good = await probe(yBody.id);
  record(
    'этап 14: опечатка в служебной папке — проверка отказывает STAGING_NOT_FOUND без создания папки; исправленная версия — ok; версии путей ведутся',
    v2.status === 201 && bad.d?.lastProbe?.errorCode === 'STAGING_NOT_FOUND' && !existsSync(join(base, 'нет-такой-папки')) && v3.status === 201 && good.d?.lastProbe?.outcome === 'ok' && good.d?.current?.version === 3,
    `${bad.d?.lastProbe?.errorCode ?? '—'} → ${good.d?.lastProbe?.outcome ?? '—'}`,
  );

  // Алгоритм размещения на временных папках — сценарий живой проверки в режиме --fixture.
  const fx = join(base, 'fixture');
  const fxSync = join(fx, 'sync', 'Контур');
  const fxStaging = join(fx, 'staging');
  const fxShare = join(fx, 'share');
  for (const d of [fxSync, fxStaging, fxShare]) mkdirSync(d, { recursive: true });
  const logFile = join(fx, 'live-fixture.log');
  const run = spawnSync(process.execPath, ['scripts/delivery-live-smoke.ts', '--fixture', '--out', logFile], {
    cwd: root,
    env: { ...env, DELIVERY_LIVE_YANDEX_ROOT: fxSync, DELIVERY_LIVE_YANDEX_STAGING: fxStaging, DELIVERY_LIVE_SMB_ROOT: fxShare },
    encoding: 'utf8',
  });
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  record(
    'этап 14: сценарий живой проверки на временных папках (FIXTURE): доступ, размещение, сверка, повтор без записи, конфликт без перезаписи — оба назначения',
    run.status === 0 && /FIXTURE/u.test(log) && (log.match(/^\[PASS\]/gmu) ?? []).length === 10 && !log.includes(base),
    `код ${run.status}`,
  );
  rmSync(base, { recursive: true, force: true });
  return { destinationIds: [yBody.id, mBody.id] };
};
