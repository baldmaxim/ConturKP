// Этап 17 (проект §12.3): XML служб WinSW и команда расписания копии — проверяются на Linux по правилам путей Windows.
// Живая установка служб — на целевом ПК (ревьюер).
import { describe, expect, it } from 'vitest';
import { backupTaskCommand, renderServiceXml } from '../scripts/ops/service-lib.ts';

const base = {
  installDir: 'D:\\Kontur & Co\\app',
  nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
  envFile: 'D:\\Kontur & Co\\config\\kontur.env',
  logsDir: 'D:\\Kontur & Co\\logs',
  graceSeconds: 20,
  pgService: 'postgresql-x64-18',
};

describe('службы WinSW', () => {
  it('server: node.exe напрямую, файл окружения, автозапуск, перезапуск, журнал с ротацией, зависимость от PostgreSQL', () => {
    const x = renderServiceXml('server', base);
    expect(x).toContain('<id>kontur-server</id>');
    expect(x).toContain('<executable>C:\\Program Files\\nodejs\\node.exe</executable>');
    expect(x).toContain('<arguments>--env-file=&quot;D:\\Kontur &amp; Co\\config\\kontur.env&quot; apps\\server\\src\\main.ts</arguments>');
    expect(x).toContain('<workingdirectory>D:\\Kontur &amp; Co\\app</workingdirectory>');
    expect(x).toContain('<startmode>Automatic</startmode>');
    expect(x).toContain('<depend>postgresql-x64-18</depend>');
    expect(x).toContain('<stoptimeout>30sec</stoptimeout>');
    expect(x.match(/<onfailure action="restart"/gu)).toHaveLength(3);
    expect(x).toContain('<log mode="roll-by-size">');
    expect(x).not.toMatch(/password|serviceaccount|npm|cmd\.exe/iu);
    expect(x.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n')).toBe(true);
  });

  it('worker без нативной службы PostgreSQL (Docker): зависимости нет; срок остановки — по SHUTDOWN_GRACE_SECONDS + 10', () => {
    const x = renderServiceXml('worker', { ...base, pgService: null, graceSeconds: 45 });
    expect(x).toContain('<id>kontur-worker</id>');
    expect(x).toContain('apps\\worker\\src\\main.ts');
    expect(x).not.toContain('<depend>');
    expect(x).toContain('<stoptimeout>55sec</stoptimeout>');
  });

  it('расписание копии: ежедневно, пароль задачи спрашивается скрыто (/RP *), команда — node backup.ts с файлом окружения', () => {
    const c = backupTaskCommand({ nodeExe: base.nodeExe, envFile: base.envFile, installDir: base.installDir, at: '02:00', account: 'MSTROY\\svc' });
    expect(c).toMatch(/^schtasks \/Create \/TN "Kontur KP backup" \/SC DAILY \/ST 02:00 \/RU "MSTROY\\svc" \/RP \* /u);
    expect(c).toContain('scripts\\ops\\backup.ts');
    expect(c).toContain('--env-file=\\"D:\\Kontur & Co\\config\\kontur.env\\"');
  });
});
