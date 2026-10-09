// Живая проверка размещения (этап 14; D-034; проект §16): синтетический набор файлов (без данных тендера) размещается
// в настоящие тестовые назначения тем же адаптером и тем же алгоритмом, что у worker (FsDeliveryTarget + placeFolder),
// без БД портала. Запускать под той же учётной записью, что и служба worker:
//   npm run delivery:live-smoke [-- --out <файл журнала>]
// Пути — только из окружения или .env (локальные настройки, не чат):
//   DELIVERY_LIVE_YANDEX_ROOT     — папка внутри локальной папки синхронизации Яндекс Диска;
//   DELIVERY_LIVE_YANDEX_STAGING  — служебная папка вне папки синхронизации, на том же диске;
//   DELIVERY_LIVE_SMB_ROOT        — тестовая сетевая папка (UNC); DELIVERY_LIVE_SMB_STAGING — по желанию.
// Сценарий по каждому назначению: проверка доступа (запись, перенос, удаление пробной папки), размещение, сверка,
// повтор без записи, конфликт со своим тестовым файлом без перезаписи. Удаляется только своя служебная папка; папки
// проверки остаются в назначении — для проверки облака: скачать папку из веб-интерфейса Диска и сверить
// `npm run delivery:compare -- <скачанная папка> --marker-sha256 <SHA-256 признака из журнала>`.
// --fixture — прогон на временных папках (smoke): журнал помечается FIXTURE, это не живая проверка.
// В журнал — коды, относительные пути папок проверки и хэши; полных путей пользователя нет.
// Код выхода: 0 — PASS (оба назначения), 1 — FAIL, 3 — NOT_RUN (назначение не настроено; второе — PASS или не настроено).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeliveryAdapterError,
  FsDeliveryTarget,
  PlacementConflict,
  placeFolder,
  type DeliveryTargetKind,
  type IDeliveryFs,
  type IPlacementFile,
} from '../packages/adapters/src/index.ts';
import { canonicalJson, isPathInside, PLACEMENT_MARKER, PLACEMENT_SCHEMA, rootPathProblem } from '../packages/core/src/index.ts';
import { nodeDeliveryFs } from '../packages/storage/src/index.ts';
import { argValue, hasFlag } from './cli.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = hasFlag('fixture');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = resolve(argValue('out') ?? join(ROOT, 'artifacts', 'stage-14', `live-${stamp}.log`));

type Status = 'PASS' | 'FAIL' | 'NOT_RUN';
const lines: string[] = [];
const say = (status: Status | 'INFO', who: string, text: string): void => {
  lines.push(`[${status}] ${who}: ${text}`);
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// Подсчёт изменяющих операций: повтор по размещённой папке не должен ничего записать.
const counting = (inner: IDeliveryFs) => {
  const n = { writes: 0 };
  const fs: IDeliveryFs = {
    ...inner,
    writeFile: async (p, src, ex) => {
      n.writes += 1;
      return inner.writeFile(p, src, ex);
    },
    rename: async (a, b) => {
      n.writes += 1;
      return inner.rename(a, b);
    },
    moveNoReplace: async (a, b) => {
      n.writes += 1;
      return inner.moveNoReplace(a, b);
    },
  };
  return { fs, n };
};

interface IDirection {
  kind: DeliveryTargetKind;
  who: string;
  root: string | undefined;
  staging: string | undefined;
  rootKey: string;
  stagingKey: string;
}

const directions: IDirection[] = [
  {
    kind: 'yandex_disk',
    who: 'Яндекс Диск',
    root: process.env.DELIVERY_LIVE_YANDEX_ROOT,
    staging: process.env.DELIVERY_LIVE_YANDEX_STAGING,
    rootKey: 'DELIVERY_LIVE_YANDEX_ROOT',
    stagingKey: 'DELIVERY_LIVE_YANDEX_STAGING',
  },
  {
    kind: 'smb',
    who: 'сетевая папка',
    root: process.env.DELIVERY_LIVE_SMB_ROOT,
    staging: process.env.DELIVERY_LIVE_SMB_STAGING,
    rootKey: 'DELIVERY_LIVE_SMB_ROOT',
    stagingKey: 'DELIVERY_LIVE_SMB_STAGING',
  },
];

// Синтетический набор: текст с кириллицей в имени, двоичный файл 1,5 МБ, пустой файл.
const syntheticSet = (runId: string): { files: (IPlacementFile & { bytes: Buffer })[]; marker: Buffer } => {
  const raw = [
    { path: '01 Проверка размещения.txt', bytes: Buffer.from(`Контур КП: живая проверка размещения ${runId}\n`, 'utf8') },
    { path: '02 Двоичный файл.bin', bytes: randomBytes(1_572_864) },
    { path: '03 Пустой файл.txt', bytes: Buffer.alloc(0) },
  ];
  const files = raw.map((f) => ({ path: f.path, bytes: f.bytes, sha256: sha(f.bytes), size: f.bytes.length, open: () => Readable.from([f.bytes]) }));
  const marker = {
    schema: PLACEMENT_SCHEMA,
    release: { id: `live-check-${runId}`, mode: 'test', contentHash: sha(Buffer.concat(raw.map((f) => f.bytes))), releaseManifestSha256: '0'.repeat(64) },
    fileSet: 'customer',
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return { files, marker: Buffer.from(canonicalJson(marker), 'utf8') };
};

const describe = (e: unknown): string =>
  e instanceof DeliveryAdapterError ? `${e.code}: ${e.message}` : e instanceof PlacementConflict ? `конфликт: ${e.message}` : e instanceof Error ? `ошибка: ${e.message.slice(0, 200)}` : 'ошибка';

const runDirection = async (d: IDirection): Promise<Status> => {
  if (!d.root) {
    say('NOT_RUN', d.who, `не задан ${d.rootKey}`);
    return 'NOT_RUN';
  }
  const staging = d.staging ?? (d.kind === 'smb' ? `${d.root.replace(/[\\/]+$/u, '')}${d.root.startsWith('/') ? '/' : '\\'}.kontur-staging` : undefined);
  if (!staging) {
    say('NOT_RUN', d.who, `не задан ${d.stagingKey}: служебная папка вне папки синхронизации, на том же диске`);
    return 'NOT_RUN';
  }
  const problem = rootPathProblem(d.root) ?? rootPathProblem(staging);
  if (problem) {
    say('FAIL', d.who, `путь в настройках: ${problem}`);
    return 'FAIL';
  }
  if (d.kind === 'yandex_disk' && (isPathInside(staging, d.root) || isPathInside(d.root, staging))) {
    say('FAIL', d.who, `${d.stagingKey} должна быть вне папки синхронизации`);
    return 'FAIL';
  }
  const { fs, n } = counting(nodeDeliveryFs());
  const target = new FsDeliveryTarget({ kind: d.kind, rootPath: d.root, stagingPath: staging, fs, timeoutMs: 120_000 });
  const runId = randomUUID().replace(/-/g, '').slice(0, 8);
  const base = `Проверка размещения Контур КП/${stamp.slice(0, 19)} ${runId}`;
  let ok = true;
  const check = (pass: boolean, text: string): boolean => {
    say(pass ? 'PASS' : 'FAIL', d.who, text);
    ok &&= pass;
    return pass;
  };
  const owns: string[] = [];
  try {
    // 1. Доступ учётной записи процесса.
    try {
      await target.probe();
      check(true, `доступ учётной записи «${userInfo().username}»: запись, чтение, перенос пробной папки в корень и обратно, удаление`);
    } catch (e) {
      check(false, `проверка доступа: ${describe(e)}`);
      return 'FAIL';
    }
    // 2. Размещение синтетического набора.
    const set = syntheticSet(runId);
    const plan = { own: `live-${runId}-1`, targetFolder: `${base}/Выпуск 1 ${runId}`, files: set.files, marker: { name: PLACEMENT_MARKER, bytes: set.marker, sha256: sha(set.marker) } };
    owns.push(plan.own);
    const placed = await placeFolder(target, plan).catch((e: unknown) => describe(e));
    if (!check(placed === 'placed', `размещение: ${placed === 'placed' ? 'папка проверки перенесена целиком, признак готовности записан последним' : placed}`)) return 'FAIL';
    let exact = true;
    for (const f of set.files) {
      const e = await target.inspect('root', `${plan.targetFolder}/${f.path}`);
      exact &&= e?.type === 'file' && e.sha256 === f.sha256 && e.size === f.size;
    }
    const m = await target.inspect('root', `${plan.targetFolder}/${PLACEMENT_MARKER}`);
    const names = (await target.list('root', plan.targetFolder)).sort();
    check(
      exact && m?.type === 'file' && m.sha256 === plan.marker.sha256 && names.join('|') === [...set.files.map((f) => f.path), PLACEMENT_MARKER].sort().join('|'),
      `сверка: ${set.files.length} файла и признак, SHA-256 и размеры совпали, посторонних нет; папка «${plan.targetFolder}»`,
    );
    say('INFO', d.who, `SHA-256 признака готовности: ${plan.marker.sha256}`);
    // 3. Повтор: ничего не пишется.
    const before = n.writes;
    const again = await placeFolder(target, plan).catch((e: unknown) => describe(e));
    check(again === 'already_placed' && n.writes === before, `повтор размещения: ${again === 'already_placed' ? 'сверка без записи' : again}, изменяющих операций ${n.writes - before}`);
    // 4. Конфликт: в папке выпуска свой тестовый файл с другим содержимым.
    const plan2 = { ...plan, own: `live-${runId}-2`, targetFolder: `${base}/Выпуск 2 ${runId}` };
    owns.push(plan2.own);
    await target.ensureFolder('root', plan2.targetFolder);
    const foreign = Buffer.from(`тестовый файл живой проверки ${runId}: другое содержимое\n`, 'utf8');
    await fs.writeFile(join(d.root, ...`${plan2.targetFolder}/${set.files[0]!.path}`.split('/')), foreign, true);
    const conflict = await placeFolder(target, plan2).then(
      () => 'размещено',
      (e: unknown) => (e instanceof PlacementConflict ? 'conflict' : describe(e)),
    );
    const kept = await target.inspect('root', `${plan2.targetFolder}/${set.files[0]!.path}`);
    const marker2 = await target.inspect('root', `${plan2.targetFolder}/${PLACEMENT_MARKER}`);
    check(conflict === 'conflict' && kept?.type === 'file' && kept.sha256 === sha(foreign) && marker2 === null, `конфликт: ${conflict === 'conflict' ? 'файл не перезаписан, признака нет' : conflict}`);
    if (d.kind === 'yandex_disk') {
      say('INFO', d.who, 'облако: портал синхронизацию не наблюдает. Дождитесь синхронизации, скачайте папку проверки из веб-интерфейса Диска и выполните:');
      say('INFO', d.who, `npm run delivery:compare -- "<скачанная папка «Выпуск 1 ${runId}»>" --marker-sha256 ${plan.marker.sha256}`);
    }
  } catch (e) {
    check(false, describe(e));
  } finally {
    for (const own of owns) await target.removeOwnStaging(own).catch(() => undefined);
  }
  return ok ? 'PASS' : 'FAIL';
};

const run = async (): Promise<number> => {
  const results: Status[] = [];
  for (const d of directions) results.push(await runDirection(d));
  const final: Status = results.includes('FAIL') ? 'FAIL' : results.includes('NOT_RUN') ? 'NOT_RUN' : 'PASS';
  const text = [
    `# npm run delivery:live-smoke — ${new Date().toISOString()}`,
    `# Режим: ${FIXTURE ? 'FIXTURE (временные папки, не живая проверка)' : 'LIVE (настоящие назначения)'}; Node ${process.version}, ${process.platform}`,
    ...lines,
    `Итог: ${final}`,
    '',
  ].join('\n');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(text);
  return final === 'PASS' ? 0 : final === 'NOT_RUN' ? 3 : 1;
};

process.exitCode = await run();
