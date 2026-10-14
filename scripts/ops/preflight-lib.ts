// Осмотр целевого ПК (этап 17, проект §12.1): только чтение, без секретов. Сбор фактов отделён от среды —
// команды, файлы и сеть внедряются, поэтому разбор вывода Windows проверяется тестами на Linux (path.win32).
// Значения переменных окружения в отчёт не попадают: из окружения берутся только адреса модели (сами адреса
// не печатаются — только вид «loopback / LAN / не задан») и каталоги для поиска программ.
import { posix, win32 } from 'node:path';

export interface ICommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface IOsFacts {
  hostname: string;
  type: string;
  release: string;
  version: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  freeMem: number;
  uptimeSec: number;
  ipv4: string[];
  timeZone: string;
}

export interface IPreflightDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  os: IOsFacts;
  nodeVersion: string;
  run: (file: string, args: string[], timeoutMs?: number) => Promise<ICommandResult>;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
  listDir: (path: string) => string[];
  statfs: (path: string) => { total: number; free: number } | null;
  fetchJson: (url: string, timeoutMs: number) => Promise<{ status: number; body: unknown } | { error: string }>;
  libreofficeVersion: () => Promise<string | null>;
  findSoffice: () => string | null;
  now: () => Date;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown' | 'n/a';

export interface ICheck {
  id: string;
  status: CheckStatus;
  note: string;
}

export interface IPgService {
  name: string;
  state: string;
  startMode: string;
  account: string;
  version: string | null;
  vector: string | null;
  pgTrgm: boolean | null;
}

export interface IPreflightReport {
  format: 'kontur.preflight.v1';
  collectedAt: string;
  host: {
    hostname: string;
    platform: string;
    os: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    memTotalGb: number;
    memFreeGb: number;
    uptimeHours: number;
    ipv4: string[];
    timeZone: string;
    windowsTimeZone: string | null;
    account: string | null;
    isAdmin: boolean | null;
  };
  node: { version: string };
  disks: Array<{ mount: string; totalGb: number; freeGb: number }>;
  physicalDisks: Array<{ name: string; mediaType: string; sizeGb: number }>;
  gpu: { status: 'found' | 'absent' | 'error'; devices: Array<{ name: string; memoryTotalMb: number | null; memoryUsedMb: number | null; driver: string }> };
  postgres: { services: IPgService[]; pgDumpOnPath: string | null; pgBinDir: { configured: boolean; pgDump: string | null } };
  docker: { client: string | null; server: string | null };
  buildTools: { vswhere: boolean; vcTools: boolean | null };
  libreoffice: { found: boolean; version: string | null };
  fonts: { system: Record<string, boolean>; perUserOnly: string[] };
  model: Array<{ purpose: 'chat' | 'embeddings'; address: 'not_configured' | 'loopback' | 'lan' | 'default'; status: 'ok' | 'unreachable' | 'auth_required' | 'error'; models: string[] }>;
  yandexDisk: { process: boolean | null; folder: boolean | null };
  network: { profiles: Array<{ name: string; category: string }>; firewall: Array<{ profile: string; enabled: string }> };
  power: { scheme: string | null; standbyAcSeconds: number | null; hibernateAcSeconds: number | null };
  mkcert: string | null;
  checks: ICheck[];
}

const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const firstLine = (s: string): string => s.trim().split(/\r?\n/u)[0]?.trim() ?? '';

// Шрифты реальных форм (docs/runbooks/libreoffice.md): файлы в системном каталоге Windows.
const FONT_FILES: Record<string, string[]> = {
  'Times New Roman': ['times.ttf'],
  Arial: ['arial.ttf'],
  Calibri: ['calibri.ttf'],
};

// PowerShell 5.1: вывод UTF-8 и JSON. Один объект ConvertTo-Json отдаёт без массива — нормализуется в asArray.
const PS_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference="SilentlyContinue"; ';
const ps = (d: IPreflightDeps, script: string): Promise<ICommandResult> =>
  d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PREFIX + script], 30_000);

const parseJson = (s: string): unknown => {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
};

const asArray = (v: unknown): Record<string, unknown>[] => {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  return typeof v === 'object' && v !== null ? [v as Record<string, unknown>] : [];
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// Адрес модели печатается только видом: адреса не секрет, но в журнал ревью их не несём.
export const addressKind = (url: string | undefined): 'not_configured' | 'loopback' | 'lan' => {
  if (!url) return 'not_configured';
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, '');
    return host === 'localhost' || host === '::1' || /^127\./u.test(host) ? 'loopback' : 'lan';
  } catch {
    return 'lan';
  }
};

// Путь исполняемого файла службы: "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" runservice -N ...
export const serviceExe = (pathName: string): string | null => {
  const quoted = /^"([^"]+)"/u.exec(pathName.trim());
  if (quoted) return quoted[1] ?? null;
  const bare = /^(\S+\.exe)/iu.exec(pathName.trim());
  return bare ? (bare[1] ?? null) : null;
};

// powercfg /query: последние два шестнадцатеричных значения — индекс от сети и от батареи (вывод локализован).
export const parsePowerIndex = (out: string): number | null => {
  const values = [...out.matchAll(/:\s*0x([0-9a-f]+)/giu)].map((m) => Number.parseInt(m[1] ?? '', 16));
  return values.length >= 2 ? (values[values.length - 2] ?? null) : null;
};

export const parseActiveScheme = (out: string): string | null => {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(([^)]+)\)/iu.exec(out);
  return m ? `${m[2]?.trim()} (${m[1]})` : null;
};

export const parseNvidiaSmi = (out: string): IPreflightReport['gpu']['devices'] =>
  out
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, total, used, driver] = l.split(',').map((x) => x.trim());
      const num = (x: string | undefined): number | null => (x && /^\d+$/u.test(x) ? Number(x) : null);
      return { name: name ?? '', memoryTotalMb: num(total), memoryUsedMb: num(used), driver: driver ?? '' };
    });

export const parseVectorVersion = (control: string | null): string | null => {
  if (control === null) return null;
  const m = /default_version\s*=\s*'([^']+)'/u.exec(control);
  return m ? (m[1] ?? 'unknown') : 'unknown';
};

const versionAtLeast = (v: string, major: number, minor: number): boolean => {
  const m = /(\d+)\.(\d+)/u.exec(v);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > major || (a === major && b >= minor);
};

const pgMajor = (v: string | null): number | null => {
  const m = v ? /PostgreSQL\)?\s+(\d+)/u.exec(v) : null;
  return m ? Number(m[1]) : null;
};

const collectPostgres = async (d: IPreflightDeps, p: typeof win32 | typeof posix): Promise<IPreflightReport['postgres']> => {
  const services: IPgService[] = [];
  if (d.platform === 'win32') {
    const r = await ps(d, "Get-CimInstance Win32_Service -Filter \"Name LIKE 'postgresql%'\" | Select-Object Name,State,StartMode,PathName,StartName | ConvertTo-Json -Compress");
    for (const s of asArray(parseJson(r.stdout))) {
      const exe = serviceExe(str(s.PathName));
      const bin = exe ? p.dirname(exe) : null;
      const pg = bin ? await d.run(p.join(bin, 'postgres.exe'), ['--version'], 15_000) : null;
      const ext = bin ? p.join(bin, '..', 'share', 'extension') : null;
      services.push({
        name: str(s.Name),
        state: str(s.State),
        startMode: str(s.StartMode),
        account: str(s.StartName),
        version: pg && pg.code === 0 ? firstLine(pg.stdout) : null,
        vector: ext ? parseVectorVersion(d.readText(p.join(ext, 'vector.control'))) : null,
        pgTrgm: ext ? d.exists(p.join(ext, 'pg_trgm.control')) : null,
      });
    }
  }
  const onPath = await d.run(d.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump', ['--version'], 15_000);
  const binDir = d.env.PG_BIN_DIR;
  const fromBin = binDir ? await d.run(p.join(binDir, d.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), ['--version'], 15_000) : null;
  return {
    services,
    pgDumpOnPath: onPath.code === 0 ? firstLine(onPath.stdout) : null,
    pgBinDir: { configured: Boolean(binDir), pgDump: fromBin && fromBin.code === 0 ? firstLine(fromBin.stdout) : null },
  };
};

const collectModels = async (d: IPreflightDeps): Promise<IPreflightReport['model']> => {
  const out: IPreflightReport['model'] = [];
  const targets: Array<{ purpose: 'chat' | 'embeddings'; url: string | undefined }> = [
    { purpose: 'chat', url: d.env.MODEL_BASE_URL },
    { purpose: 'embeddings', url: d.env.EMBEDDING_BASE_URL },
  ];
  for (const t of targets) {
    // Не задан — смотрим адрес LM Studio по умолчанию, чтобы осмотр показал, работает ли он на ПК.
    const base = t.url ?? 'http://127.0.0.1:1234/v1';
    const address = t.url ? addressKind(t.url) : 'default';
    if (address === 'not_configured') continue;
    if (!t.url && out.some((o) => o.address === 'default')) continue;
    const r = await d.fetchJson(`${base.replace(/\/+$/u, '')}/models`, 3000);
    if ('error' in r) {
      out.push({ purpose: t.purpose, address, status: 'unreachable', models: [] });
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      out.push({ purpose: t.purpose, address, status: 'auth_required', models: [] });
      continue;
    }
    const data = (r.body as { data?: unknown } | null)?.data;
    const models = Array.isArray(data) ? data.map((m) => str((m as { id?: unknown }).id)).filter(Boolean) : [];
    out.push({ purpose: t.purpose, address, status: r.status === 200 ? 'ok' : 'error', models });
  }
  return out;
};

export const collectPreflight = async (d: IPreflightDeps): Promise<IPreflightReport> => {
  const win = d.platform === 'win32';
  const p = win ? win32 : posix;
  const env = d.env;

  // Диски: фиксированные буквы Windows или корень Linux; размеры — через statfs.
  const mounts = win ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((m) => d.exists(m)) : ['/'];
  const disks = mounts.flatMap((mount) => {
    const s = d.statfs(mount);
    return s ? [{ mount, totalGb: round1(s.total / GB), freeGb: round1(s.free / GB) }] : [];
  });

  const physicalDisks = win
    ? asArray(parseJson((await ps(d, 'Get-PhysicalDisk | Select-Object FriendlyName,@{n="MediaType";e={"$($_.MediaType)"}},Size | ConvertTo-Json -Compress')).stdout)).map((x) => ({
        name: str(x.FriendlyName),
        mediaType: str(x.MediaType),
        sizeGb: round1(Number(x.Size ?? 0) / GB),
      }))
    : [];

  const smi = await d.run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'], 15_000);
  const gpu: IPreflightReport['gpu'] =
    smi.code === 0 ? { status: 'found', devices: parseNvidiaSmi(smi.stdout) } : { status: smi.error === 'ENOENT' ? 'absent' : 'error', devices: [] };

  const postgres = await collectPostgres(d, p);

  const dockerOut = await d.run('docker', ['version', '--format', '{{.Client.Version}}|{{.Server.Version}}'], 15_000);
  const [client, server] = dockerOut.stdout.trim().split('|');
  const docker = { client: client && dockerOut.error !== 'ENOENT' ? client : null, server: server && dockerOut.code === 0 ? server : null };

  let buildTools: IPreflightReport['buildTools'] = { vswhere: false, vcTools: null };
  if (win) {
    const vswhere = p.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (d.exists(vswhere)) {
      const r = await d.run(vswhere, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], 15_000);
      buildTools = { vswhere: true, vcTools: r.code === 0 && r.stdout.trim().length > 0 };
    }
  }

  const soffice = d.findSoffice();
  const libreoffice = { found: soffice !== null, version: soffice ? await d.libreofficeVersion() : null };

  const system: Record<string, boolean> = {};
  let perUserOnly: string[] = [];
  if (win) {
    const sysDir = p.join(env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows', 'Fonts');
    const sysFiles = new Set(d.listDir(sysDir).map((f) => f.toLowerCase()));
    for (const [font, files] of Object.entries(FONT_FILES)) system[font] = files.some((f) => sysFiles.has(f));
    // Шрифт, поставленный только для пользователя, служба worker может не увидеть (Review 12-3, 13-4).
    const userDir = env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null;
    perUserOnly = userDir ? d.listDir(userDir).filter((f) => /\.(ttf|otf|ttc)$/iu.test(f) && !sysFiles.has(f.toLowerCase())) : [];
  }

  const model = await collectModels(d);

  let yandexDisk: IPreflightReport['yandexDisk'] = { process: null, folder: null };
  let network: IPreflightReport['network'] = { profiles: [], firewall: [] };
  let power: IPreflightReport['power'] = { scheme: null, standbyAcSeconds: null, hibernateAcSeconds: null };
  let windowsTimeZone: string | null = null;
  let isAdmin: boolean | null = null;
  if (win) {
    const yp = await ps(d, 'Get-Process -Name YandexDisk2,YandexDisk | Select-Object -ExpandProperty ProcessName | ConvertTo-Json -Compress');
    const folder = env.USERPROFILE ? d.exists(p.join(env.USERPROFILE, 'YandexDisk')) : null;
    yandexDisk = { process: parseJson(yp.stdout) !== null, folder };
    const prof = await ps(d, 'Get-NetConnectionProfile | Select-Object Name,@{n="Category";e={"$($_.NetworkCategory)"}} | ConvertTo-Json -Compress');
    const fw = await ps(d, 'Get-NetFirewallProfile | Select-Object Name,@{n="Enabled";e={"$($_.Enabled)"}} | ConvertTo-Json -Compress');
    network = {
      profiles: asArray(parseJson(prof.stdout)).map((x) => ({ name: str(x.Name), category: str(x.Category) })),
      firewall: asArray(parseJson(fw.stdout)).map((x) => ({ profile: str(x.Name), enabled: str(x.Enabled) })),
    };
    const scheme = await d.run('powercfg', ['/getactivescheme'], 15_000);
    const standby = await d.run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], 15_000);
    const hibernate = await d.run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'HIBERNATEIDLE'], 15_000);
    power = {
      scheme: scheme.code === 0 ? parseActiveScheme(scheme.stdout) : null,
      standbyAcSeconds: standby.code === 0 ? parsePowerIndex(standby.stdout) : null,
      hibernateAcSeconds: hibernate.code === 0 ? parsePowerIndex(hibernate.stdout) : null,
    };
    const tz = await d.run('tzutil', ['/g'], 15_000);
    windowsTimeZone = tz.code === 0 ? firstLine(tz.stdout) : null;
    const admin = await ps(d, '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress');
    const a = parseJson(admin.stdout);
    isAdmin = typeof a === 'boolean' ? a : null;
  }

  const who = await d.run('whoami', [], 15_000);
  const mk = await d.run('mkcert', ['-version'], 15_000);

  const report: IPreflightReport = {
    format: 'kontur.preflight.v1',
    collectedAt: d.now().toISOString(),
    host: {
      hostname: d.os.hostname,
      platform: d.platform,
      os: `${d.os.type} ${d.os.release} ${d.os.version}`.trim(),
      arch: d.os.arch,
      cpuModel: d.os.cpuModel,
      cpuCount: d.os.cpuCount,
      memTotalGb: round1(d.os.totalMem / GB),
      memFreeGb: round1(d.os.freeMem / GB),
      uptimeHours: round1(d.os.uptimeSec / 3600),
      ipv4: d.os.ipv4,
      timeZone: d.os.timeZone,
      windowsTimeZone,
      account: who.code === 0 ? firstLine(who.stdout) : null,
      isAdmin,
    },
    node: { version: d.nodeVersion },
    disks,
    physicalDisks,
    gpu,
    postgres,
    docker,
    buildTools,
    libreoffice,
    fonts: { system, perUserOnly },
    model,
    yandexDisk,
    network,
    power,
    mkcert: mk.code === 0 ? firstLine(mk.stdout) : null,
    checks: [],
  };
  report.checks = judge(report);
  return report;
};

// Оценки — только там, где есть требование проекта; остальное — факты для решения (D-040).
export const judge = (r: IPreflightReport): ICheck[] => {
  const win = r.host.platform === 'win32';
  const checks: ICheck[] = [];
  const add = (id: string, status: CheckStatus, note: string): void => {
    checks.push({ id, status, note });
  };
  const nodeOk = versionAtLeast(r.node.version, 24, 11) && !versionAtLeast(r.node.version, 25, 0);
  add('node', nodeOk ? 'ok' : 'fail', `Node ${r.node.version}; нужен >=24.11 <25 (package.json engines)`);

  const pgOk = r.postgres.services.filter((s) => (pgMajor(s.version) ?? 0) >= 17 && s.vector !== null && versionAtLeast(s.vector, 0, 8) && s.pgTrgm === true);
  if (!win) add('postgres_service', 'n/a', 'службы Windows — только на целевом ПК');
  else if (pgOk.length > 0) add('postgres_service', 'ok', `нативная служба: ${pgOk.map((s) => `${s.name} (${s.version}, vector ${s.vector})`).join('; ')}`);
  else if (r.postgres.services.length > 0) add('postgres_service', 'warn', 'служба PostgreSQL есть, но нет версии ≥17 с vector ≥0.8 и pg_trgm (ADR-002)');
  else add('postgres_service', 'warn', 'нативной службы PostgreSQL нет');
  add('docker', r.docker.server ? 'ok' : r.docker.client ? 'warn' : 'n/a', r.docker.server ? `Docker ${r.docker.server}` : r.docker.client ? 'клиент Docker есть, служба не отвечает' : 'Docker не найден');
  add('pg_dump', r.postgres.pgDumpOnPath || r.postgres.pgBinDir.pgDump ? 'ok' : 'warn', r.postgres.pgDumpOnPath ?? r.postgres.pgBinDir.pgDump ?? 'pg_dump не найден ни в PATH, ни в PG_BIN_DIR');

  const gpuNote = r.gpu.devices.map((g) => `${g.name}, ${g.memoryTotalMb ?? '?'} МБ`).join('; ');
  add('gpu', r.gpu.status === 'found' ? 'ok' : 'warn', r.gpu.status === 'found' ? gpuNote : 'nvidia-smi не найден или не ответил: живая модель на GPU невозможна');
  const lm = r.model.find((m) => m.status === 'ok');
  add('model_server', lm ? 'ok' : 'warn', lm ? `сервер модели отвечает, моделей в списке: ${lm.models.length}` : 'OpenAI-совместимый сервер модели не отвечает');

  add('libreoffice', r.libreoffice.version ? 'ok' : 'fail', r.libreoffice.version ?? 'LibreOffice не найден или не запускается (docs/runbooks/libreoffice.md)');
  if (win) {
    const missing = Object.entries(r.fonts.system).filter(([, v]) => !v).map(([k]) => k);
    add('fonts_system', missing.length === 0 ? 'ok' : 'warn', missing.length === 0 ? 'Times New Roman, Arial, Calibri — для всех пользователей' : `нет в системном каталоге: ${missing.join(', ')}`);
    add('fonts_per_user', r.fonts.perUserOnly.length === 0 ? 'ok' : 'warn', r.fonts.perUserOnly.length === 0 ? 'шрифтов только для пользователя нет' : `только для пользователя (служба может не увидеть): ${r.fonts.perUserOnly.join(', ')}`);
    const sleep = r.power.standbyAcSeconds;
    add('sleep', sleep === null ? 'unknown' : sleep === 0 ? 'ok' : 'warn', sleep === null ? 'не удалось прочитать' : sleep === 0 ? 'сон от сети отключён' : `ПК уходит в сон через ${Math.round(sleep / 60)} мин от сети — службы будут недоступны`);
    const pub = r.network.profiles.filter((x) => /^public$/iu.test(x.category));
    add('network_profile', r.network.profiles.length === 0 ? 'unknown' : pub.length > 0 ? 'warn' : 'ok', r.network.profiles.map((x) => `${x.name}: ${x.category}`).join('; ') || 'нет данных');
  }
  for (const disk of r.disks) add(`disk ${disk.mount}`, disk.freeGb < 10 ? 'warn' : 'ok', `свободно ${disk.freeGb} из ${disk.totalGb} ГБ (порог предупреждения хранилища — 10 ГБ)`);
  add('mkcert', r.mkcert ? 'ok' : 'warn', r.mkcert ?? 'mkcert не найден: нужен для сертификата на IP (U-02)');
  return checks;
};
