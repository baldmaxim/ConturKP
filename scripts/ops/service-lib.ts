// Службы Windows для server и worker (этап 17, ADR-011 §1, проект §12.3): XML обёртки WinSW. Критерии ADR-011 —
// автозапуск, перезапуск при сбое, stdout/stderr в файлы с ротацией. Исполняемый файл — node.exe напрямую (не npm и не
// cmd: иначе Ctrl+C от обёртки перехватит оболочка); WinSW при остановке шлёт Ctrl+C (Node получает SIGINT) и ждёт
// stoptimeout, затем завершает процесс. Учётная запись в XML не пишется: её и пароль задаёт администратор в оснастке
// «Службы» (решение В-17-4), пароль нигде в файлах не хранится.
import { win32 } from 'node:path';

export type ServiceKind = 'server' | 'worker';

export interface IServiceOptions {
  installDir: string;
  nodeExe: string;
  envFile: string;
  logsDir: string;
  graceSeconds: number;
  pgService: string | null;
}

export const SERVICE_IDS: Record<ServiceKind, string> = { server: 'kontur-server', worker: 'kontur-worker' };
const TITLES: Record<ServiceKind, string> = { server: 'Kontur KP server', worker: 'Kontur KP worker' };
const DESCRIPTIONS: Record<ServiceKind, string> = {
  server: 'Kontur KP portal: API, web interface, /mcp (stage 17, docs/runbooks/release.md)',
  worker: 'Kontur KP portal: background jobs (stage 17, docs/runbooks/release.md)',
};

const xml = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const renderServiceXml = (kind: ServiceKind, o: IServiceOptions): string => {
  const script = win32.join('apps', kind, 'src', 'main.ts');
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<service>',
    `  <id>${SERVICE_IDS[kind]}</id>`,
    `  <name>${TITLES[kind]}</name>`,
    `  <description>${xml(DESCRIPTIONS[kind])}</description>`,
    `  <executable>${xml(o.nodeExe)}</executable>`,
    `  <arguments>${xml(`--env-file="${o.envFile}" ${script}`)}</arguments>`,
    `  <workingdirectory>${xml(o.installDir)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    '  <delayedAutoStart>true</delayedAutoStart>',
    ...(o.pgService ? [`  <depend>${xml(o.pgService)}</depend>`] : []),
    `  <stoptimeout>${o.graceSeconds + 10}sec</stoptimeout>`,
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <onfailure action="restart" delay="30 sec"/>',
    '  <onfailure action="restart" delay="60 sec"/>',
    '  <resetfailure>1 hour</resetfailure>',
    `  <logpath>${xml(o.logsDir)}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>8</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ];
  return lines.join('\r\n');
};

// Ежедневная копия планировщиком Windows: команда печатается, а не выполняется — пароль учётной записи задачи
// администратор вводит сам (/RP * спрашивает его скрыто).
export const backupTaskCommand = (o: { nodeExe: string; envFile: string; installDir: string; at: string; account: string }): string => {
  const action = `"${o.nodeExe}" --env-file="${o.envFile}" "${win32.join(o.installDir, 'scripts', 'ops', 'backup.ts')}"`;
  return `schtasks /Create /TN "Kontur KP backup" /SC DAILY /ST ${o.at} /RU "${o.account}" /RP * /RL LIMITED /F /TR "${action.replaceAll('"', '\\"')}"`;
};
