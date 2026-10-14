// Конвертер в PDF для превью (D-032 В-12-2; ADR-013 п. 4): LibreOffice без интерфейса в отдельном процессе с
// отдельным профилем во временном каталоге и ограничением времени. Отсутствие конвертера и ошибка преобразования —
// явные ошибки (`converter_unavailable`, `conversion_failed`): сборка без превью не проходит. Версия конвертера
// фиксируется (`soffice --version`). Живёт в worker: процесс и временные файлы — не дело пакета адаптеров (A38).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OfficeError, type IOfficeConverter } from '@kontur/adapters';

// Windows: консольный вход `soffice.com` — у оконного `soffice.exe` определение версии не завершалось (R12-01: 120 с
// тайм-аута на LibreOffice 26.8.0.3, через `soffice.com` того же пакета — около 2,5 с). Поэтому `.com` выбирается и в
// PATH, и в стандартном каталоге, и вместо настроенного `soffice.exe`, если рядом есть `soffice.com`.
const WINDOWS_DIRS = ['C:\\Program Files\\LibreOffice\\program', 'C:\\Program Files (x86)\\LibreOffice\\program'];

export interface ISofficeEnv {
  platform: NodeJS.Platform;
  pathEnv: string;
  exists: (path: string) => boolean;
}

const hostEnv = (): ISofficeEnv => ({ platform: process.platform, pathEnv: process.env.PATH ?? '', exists: existsSync });

// Путь к soffice: настройка, затем PATH, затем стандартный каталог установки Windows.
export const findSoffice = (configured: string | null, env: ISofficeEnv = hostEnv()): string | null => {
  const p = env.platform === 'win32' ? win32 : posix;
  const preferCom = (file: string): string => {
    if (env.platform !== 'win32' || !/soffice\.exe$/iu.test(file)) return file;
    const com = p.join(p.dirname(file), 'soffice.com');
    return env.exists(com) ? com : file;
  };
  if (configured) return env.exists(configured) ? preferCom(configured) : null;
  const names = env.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice'];
  const dirs = [...env.pathEnv.split(p.delimiter).filter(Boolean), ...(env.platform === 'win32' ? WINDOWS_DIRS : [])];
  for (const dir of dirs) {
    for (const n of names) if (env.exists(p.join(dir, n))) return p.join(dir, n);
  }
  return null;
};

// Профиль конвертации с русской локалью: числа и даты XLSX отрисовываются одинаково на любой машине (25,50, а не 25.50).
const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooSetupSystemLocale" oor:op="fuse"><value>ru-RU</value></prop></item>
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooLocale" oor:op="fuse"><value>ru-RU</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
</oor:items>
`;

const prepareProfile = async (dir: string): Promise<string> => {
  const profile = join(dir, 'profile');
  await mkdir(join(profile, 'user'), { recursive: true });
  await writeFile(join(profile, 'user', 'registrymodifications.xcu'), PROFILE_SETTINGS);
  return pathToFileURL(profile).href;
};

const run = (file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export class LibreOfficeConverter implements IOfficeConverter {
  readonly name = 'libreoffice' as const;
  private readonly path: string;
  private readonly timeoutMs: number;
  private cachedVersion: string | null = null;
  constructor(path: string, timeoutMs: number) {
    this.path = path;
    this.timeoutMs = timeoutMs;
  }

  async version(): Promise<string> {
    if (this.cachedVersion) return this.cachedVersion;
    const dir = await mkdtemp(join(tmpdir(), 'kontur-lo-'));
    try {
      const r = await run(this.path, ['--headless', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--version'], this.timeoutMs, { ...process.env, HOME: dir });
      const v = r.stdout.trim().split(/\r?\n/u)[0] ?? '';
      if (!/LibreOffice/iu.test(v)) throw new OfficeError('converter_unavailable', `не удалось определить версию конвертера: ${v.slice(0, 120)}`);
      this.cachedVersion = v.slice(0, 200);
      return this.cachedVersion;
    } catch (err) {
      if (err instanceof OfficeError) throw err;
      throw new OfficeError('converter_unavailable', `LibreOffice не запускается: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async toPdf(bytes: Buffer, ext: 'docx' | 'xlsx' | 'doc', signal?: AbortSignal): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'kontur-lo-'));
    try {
      const input = join(dir, `document.${ext}`);
      await writeFile(input, bytes);
      const profile = await prepareProfile(dir);
      try {
        await run(
          this.path,
          ['--headless', '--norestore', '--nologo', '--nolockcheck', '--nodefault', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', dir, input],
          this.timeoutMs,
          { ...process.env, HOME: dir },
          signal,
        );
      } catch (err) {
        const e = err as Error & { killed?: boolean; stderr?: string };
        throw new OfficeError('conversion_failed', e.killed ? `конвертация не уложилась в ${Math.round(this.timeoutMs / 1000)} с` : `конвертация завершилась ошибкой: ${(e.stderr || e.message).slice(0, 300)}`);
      }
      const out = join(dir, 'document.pdf');
      if (!existsSync(out)) throw new OfficeError('conversion_failed', 'конвертер не создал PDF');
      const pdf = await readFile(out);
      if (pdf.length === 0 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new OfficeError('conversion_failed', 'конвертер вернул не PDF');
      return pdf;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// Конвертер по настройке; null — не найден (сборка завершится `converter_unavailable`).
export const createOfficeConverter = (cfg: { sofficePath: string | null; convertTimeoutMs: number }): IOfficeConverter | null => {
  const path = findSoffice(cfg.sofficePath);
  return path ? new LibreOfficeConverter(path, cfg.convertTimeoutMs) : null;
};
