// Осмотр целевого ПК (этап 17, проект §12.1): разбор вывода команд Windows на Linux через внедрённую среду,
// оценки по требованиям проекта и отсутствие секретов в отчёте.
import { describe, expect, it } from 'vitest';
import { addressKind, collectPreflight, parseActiveScheme, parsePowerIndex, serviceExe, type ICommandResult, type IPreflightDeps } from '../scripts/ops/preflight-lib.ts';

const SECRET = 'S3CRET-preflight-marker';
const ok = (stdout: string): ICommandResult => ({ code: 0, stdout, stderr: '' });
const missing: ICommandResult = { code: null, stdout: '', stderr: '', error: 'ENOENT' };

// Вывод powercfg на русской Windows: значения — последние два шестнадцатеричных числа.
const POWER_RU = `GUID подгруппы: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Сон)
    GUID параметра питания: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Переход в спящий режим через)
      Минимальное возможное значение: 0x00000000
      Максимальное возможное значение: 0xffffffff
      Приращение возможных значений: 0x00000001
      Единицы возможных значений: Секунды
    Текущий индекс настройки питания от сети: 0x00000708
    Текущий индекс настройки питания от батареи: 0x00000384
`;

const winDeps = (over: Partial<Record<string, ICommandResult>> = {}, files: Record<string, string> = {}): IPreflightDeps => {
  const calls: string[] = [];
  const run = async (file: string, args: string[]): Promise<ICommandResult> => {
    const cmd = [file, ...args].join(' ');
    calls.push(cmd);
    const key = Object.keys(over).find((k) => cmd.includes(k));
    if (key) return over[key]!;
    if (file === 'powershell.exe') {
      const script = args[args.length - 1] ?? '';
      if (script.includes('Win32_Service'))
        return ok(
          JSON.stringify({
            Name: 'postgresql-x64-18',
            State: 'Running',
            StartMode: 'Auto',
            PathName: '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_ctl.exe" runservice -N "postgresql-x64-18" -D "C:\\Program Files\\PostgreSQL\\18\\data" -w',
            StartName: 'NT AUTHORITY\\NetworkService',
          }),
        );
      if (script.includes('Get-PhysicalDisk')) return ok(JSON.stringify([{ FriendlyName: 'NVMe SSD', MediaType: 'SSD', Size: 512110190592 }]));
      if (script.includes('Get-Process')) return ok('"YandexDisk2"');
      if (script.includes('Get-NetConnectionProfile')) return ok(JSON.stringify({ Name: 'MSTROY', Category: 'DomainAuthenticated' }));
      if (script.includes('Get-NetFirewallProfile')) return ok(JSON.stringify([{ Name: 'Domain', Enabled: 'True' }, { Name: 'Public', Enabled: 'True' }]));
      if (script.includes('IsInRole')) return ok('false');
      return ok('');
    }
    if (file.endsWith('postgres.exe')) return ok('postgres (PostgreSQL) 18.6\r\n');
    if (file === 'pg_dump.exe') return ok('pg_dump (PostgreSQL) 18.6\r\n');
    if (file === 'nvidia-smi') return ok('NVIDIA GeForce RTX 5050, 8151, 812, 581.57\r\n');
    if (file === 'docker') return missing;
    if (file.endsWith('vswhere.exe')) return ok('');
    if (file === 'powercfg' && args[0] === '/getactivescheme') return ok('GUID схемы питания: 381b4222-f694-41f0-9685-ff5bb260df2e  (Сбалансированная)\r\n');
    if (file === 'powercfg') return ok(POWER_RU);
    if (file === 'tzutil') return ok('Russian Standard Time');
    if (file === 'whoami') return ok('mstroy\\odintsov.a.a\r\n');
    if (file === 'mkcert') return missing;
    return missing;
  };
  const fileMap: Record<string, string> = {
    'C:\\Program Files\\PostgreSQL\\18\\share\\extension\\vector.control': "comment = 'vector data type'\ndefault_version = '0.8.1'\n",
    'C:\\Program Files\\PostgreSQL\\18\\share\\extension\\pg_trgm.control': "default_version = '1.6'\n",
    ...files,
  };
  return {
    platform: 'win32',
    env: {
      DATABASE_URL: `postgres://kontur_app:${SECRET}@127.0.0.1/kontur`,
      MODEL_API_KEY: SECRET,
      TENDERHUB_API_KEY: SECRET,
      MODEL_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCALAPPDATA: 'C:\\Users\\odintsov.a.a\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\odintsov.a.a',
      WINDIR: 'C:\\Windows',
    },
    os: {
      hostname: 'PC-REVIEW',
      type: 'Windows_NT',
      release: '10.0.26100',
      version: 'Windows 11 Pro',
      arch: 'x64',
      cpuModel: 'Intel Core i7',
      cpuCount: 16,
      totalMem: 32 * 1024 ** 3,
      freeMem: 12 * 1024 ** 3,
      uptimeSec: 7200,
      ipv4: ['192.168.10.25'],
      timeZone: 'Europe/Moscow',
    },
    nodeVersion: 'v24.13.0',
    run,
    exists: (p) => ['C:\\', 'D:\\'].includes(p) || p in fileMap || p === 'C:\\Users\\odintsov.a.a\\YandexDisk',
    readText: (p) => fileMap[p] ?? null,
    listDir: (p) => (p === 'C:\\Windows\\Fonts' ? ['TIMES.TTF', 'arial.ttf', 'segoeui.ttf'] : p.endsWith('\\Microsoft\\Windows\\Fonts') ? ['calibri.ttf', 'notes.txt'] : []),
    statfs: (p) => (p === 'C:\\' ? { total: 500 * 1024 ** 3, free: 120 * 1024 ** 3 } : p === 'D:\\' ? { total: 1000 * 1024 ** 3, free: 5 * 1024 ** 3 } : null),
    fetchJson: async (url) => (url === 'http://127.0.0.1:1234/v1/models' ? { status: 200, body: { data: [{ id: 'qwen3-8b' }, { id: 'text-embedding-bge-m3' }] } } : { error: 'TypeError' }),
    findSoffice: () => 'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    libreofficeVersion: async () => 'LibreOffice 26.8.1.1 abc',
    now: () => new Date('2026-10-14T09:00:00Z'),
  };
};

describe('осмотр целевого ПК', () => {
  it('Windows: службы PostgreSQL, vector, GPU, шрифты, питание, сеть разобраны; оценки по требованиям', async () => {
    const r = await collectPreflight(winDeps());
    expect(r.format).toBe('kontur.preflight.v1');
    expect(r.postgres.services).toEqual([
      { name: 'postgresql-x64-18', state: 'Running', startMode: 'Auto', account: 'NT AUTHORITY\\NetworkService', version: 'postgres (PostgreSQL) 18.6', vector: '0.8.1', pgTrgm: true },
    ]);
    expect(r.postgres.pgDumpOnPath).toBe('pg_dump (PostgreSQL) 18.6');
    expect(r.gpu).toEqual({ status: 'found', devices: [{ name: 'NVIDIA GeForce RTX 5050', memoryTotalMb: 8151, memoryUsedMb: 812, driver: '581.57' }] });
    expect(r.disks).toEqual([
      { mount: 'C:\\', totalGb: 500, freeGb: 120 },
      { mount: 'D:\\', totalGb: 1000, freeGb: 5 },
    ]);
    expect(r.physicalDisks).toEqual([{ name: 'NVMe SSD', mediaType: 'SSD', sizeGb: 476.9 }]);
    expect(r.fonts).toEqual({ system: { 'Times New Roman': true, Arial: true, Calibri: false }, perUserOnly: ['calibri.ttf'] });
    expect(r.power).toEqual({ scheme: 'Сбалансированная (381b4222-f694-41f0-9685-ff5bb260df2e)', standbyAcSeconds: 1800, hibernateAcSeconds: 1800 });
    expect(r.network.profiles).toEqual([{ name: 'MSTROY', category: 'DomainAuthenticated' }]);
    expect(r.yandexDisk).toEqual({ process: true, folder: true });
    expect(r.model).toEqual([
      { purpose: 'chat', address: 'loopback', status: 'ok', models: ['qwen3-8b', 'text-embedding-bge-m3'] },
      { purpose: 'embeddings', address: 'default', status: 'ok', models: ['qwen3-8b', 'text-embedding-bge-m3'] },
    ]);
    expect(r.host).toMatchObject({ windowsTimeZone: 'Russian Standard Time', account: 'mstroy\\odintsov.a.a', isAdmin: false, ipv4: ['192.168.10.25'] });
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      node: 'ok',
      postgres_service: 'ok',
      docker: 'n/a',
      pg_dump: 'ok',
      gpu: 'ok',
      model_server: 'ok',
      libreoffice: 'ok',
      fonts_system: 'warn',
      fonts_per_user: 'warn',
      sleep: 'warn',
      network_profile: 'ok',
      'disk C:\\': 'ok',
      'disk D:\\': 'warn',
      mkcert: 'warn',
    });
  });

  it('значения секретов и адреса из окружения в отчёт не попадают', async () => {
    const r = await collectPreflight(winDeps());
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('127.0.0.1:1234');
    expect(text).not.toContain('postgres://');
  });

  it('PostgreSQL 16 без vector — предупреждение; Node 25 — отказ; нет LibreOffice — отказ', async () => {
    const d = winDeps({ 'postgres.exe': ok('postgres (PostgreSQL) 16.4') });
    d.readText = (p) => (p.endsWith('pg_trgm.control') ? "default_version = '1.6'" : null);
    d.nodeVersion = 'v25.0.0';
    d.findSoffice = () => null;
    const r = await collectPreflight(d);
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.postgres_service?.status).toBe('warn');
    expect(r.postgres.services[0]?.vector).toBeNull();
    expect(byId.node?.status).toBe('fail');
    expect(byId.libreoffice?.status).toBe('fail');
  });

  it('сервер модели не отвечает или требует ключ — предупреждение, ключ не посылается', async () => {
    const d = winDeps();
    const seen: string[] = [];
    d.fetchJson = async (url) => {
      seen.push(url);
      return { status: 401, body: null };
    };
    const r = await collectPreflight(d);
    expect(r.model[0]).toMatchObject({ status: 'auth_required', models: [] });
    expect(r.checks.find((c) => c.id === 'model_server')?.status).toBe('warn');
    expect(seen.every((u) => !u.includes(SECRET))).toBe(true);
  });

  it('Linux: проверки Windows не выполняются, службы — n/a', async () => {
    const d = winDeps();
    d.platform = 'linux';
    d.exists = () => false;
    d.statfs = (p) => (p === '/' ? { total: 256 * 1024 ** 3, free: 55 * 1024 ** 3 } : null);
    const commands: string[] = [];
    const inner = d.run;
    d.run = async (f, a) => {
      commands.push(f);
      return inner(f, a);
    };
    const r = await collectPreflight(d);
    expect(commands).not.toContain('powershell.exe');
    expect(commands).not.toContain('powercfg');
    expect(r.disks).toEqual([{ mount: '/', totalGb: 256, freeGb: 55 }]);
    expect(r.checks.find((c) => c.id === 'postgres_service')?.status).toBe('n/a');
    expect(r.checks.some((c) => c.id === 'sleep')).toBe(false);
  });

  it('разбор строк: путь службы, схема питания, индекс, вид адреса', () => {
    expect(serviceExe('"C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe" runservice -N "pg"')).toBe('C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe');
    expect(serviceExe('C:\\pg\\bin\\pg_ctl.exe runservice')).toBe('C:\\pg\\bin\\pg_ctl.exe');
    expect(parseActiveScheme('Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)')).toBe('High performance (8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c)');
    expect(parsePowerIndex('Current AC Power Setting Index: 0x00000000\nCurrent DC Power Setting Index: 0x0000012c')).toBe(0);
    expect(parsePowerIndex('нет данных')).toBeNull();
    expect(addressKind('http://localhost:1234/v1')).toBe('loopback');
    expect(addressKind('http://192.168.1.5:1234/v1')).toBe('lan');
    expect(addressKind(undefined)).toBe('not_configured');
  });
});
