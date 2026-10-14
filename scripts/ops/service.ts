// npm run ops:service -- render --winsw <WinSW-x64.exe> --env-file <файл окружения> [--node <node.exe>] [--logs <каталог>]
//                                  [--pg-service <служба PostgreSQL>] [--grace <секунд>]
// npm run ops:service -- install | uninstall | start | stop | restart | status
// npm run ops:service -- backup-task --env-file <файл> --account <DOMAIN\пользователь> [--at 02:00]
// Службы Windows server и worker через WinSW (этап 17, docs/runbooks/release.md). render копирует WinSW в
// services\kontur-server.exe и kontur-worker.exe рядом с XML и печатает SHA-256 бинарника — администратор сверяет его
// со страницей выпуска WinSW. Остальные команды вызывают эти копии. Только Windows; на других ОС — код 3 (NOT_RUN).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { argValue } from '../cli.ts';
import { backupTaskCommand, renderServiceXml, SERVICE_IDS, type ServiceKind } from './service-lib.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SERVICES_DIR = win32.join(ROOT, 'services');
const KINDS: ServiceKind[] = ['worker', 'server'];

const run = (kind: ServiceKind, command: string): number => {
  const exe = win32.join(SERVICES_DIR, `${SERVICE_IDS[kind]}.exe`);
  if (!existsSync(exe)) {
    console.error(`нет ${exe}: сначала npm run ops:service -- render`);
    return 1;
  }
  const r = spawnSync(exe, [command], { encoding: 'utf8', windowsHide: true });
  process.stdout.write(`${SERVICE_IDS[kind]} ${command}: ${(r.stdout ?? '').trim()}${r.stderr ? ` ${r.stderr.trim()}` : ''}\n`);
  return r.status ?? 1;
};

const main = (): number => {
  const command = process.argv[2];
  if (process.platform !== 'win32') {
    console.log('службы Windows — только на Windows: NOT_RUN');
    return 3;
  }
  if (command === 'render') {
    const winsw = argValue('winsw');
    const envFile = argValue('env-file');
    if (!winsw || !envFile || !existsSync(winsw) || !existsSync(envFile)) {
      console.error('нужны существующие --winsw <WinSW-x64.exe> и --env-file <файл окружения вне каталога установки>');
      return 2;
    }
    const sha = createHash('sha256').update(readFileSync(winsw)).digest('hex');
    mkdirSync(SERVICES_DIR, { recursive: true });
    const logs = argValue('logs') ?? win32.join(ROOT, 'logs');
    mkdirSync(logs, { recursive: true });
    for (const kind of KINDS) {
      copyFileSync(winsw, win32.join(SERVICES_DIR, `${SERVICE_IDS[kind]}.exe`));
      writeFileSync(
        win32.join(SERVICES_DIR, `${SERVICE_IDS[kind]}.xml`),
        renderServiceXml(kind, {
          installDir: ROOT,
          nodeExe: argValue('node') ?? process.execPath,
          envFile: resolve(envFile),
          logsDir: logs,
          graceSeconds: Number(argValue('grace') ?? '20'),
          pgService: argValue('pg-service') ?? null,
        }),
      );
    }
    console.log(`службы описаны в ${SERVICES_DIR}; SHA-256 WinSW: ${sha} — сверьте со страницей выпуска`);
    return 0;
  }
  if (command === 'backup-task') {
    const envFile = argValue('env-file');
    const account = argValue('account');
    if (!envFile || !account) {
      console.error('нужны --env-file и --account');
      return 2;
    }
    console.log(backupTaskCommand({ nodeExe: argValue('node') ?? process.execPath, envFile: resolve(envFile), installDir: ROOT, at: argValue('at') ?? '02:00', account }));
    return 0;
  }
  if (['install', 'uninstall', 'start', 'stop', 'restart', 'status'].includes(command ?? '')) {
    // Порядок: worker раньше server при запуске, server раньше worker при остановке.
    const order = command === 'stop' || command === 'uninstall' ? [...KINDS].reverse() : KINDS;
    return order.map((k) => run(k, command!)).every((c) => c === 0) ? 0 : 1;
  }
  console.error('команда: render | install | uninstall | start | stop | restart | status | backup-task');
  return 2;
};

process.exitCode = main();
