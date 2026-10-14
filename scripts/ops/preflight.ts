// npm run ops:preflight [-- --out <файл.json>] — осмотр целевого ПК (этап 17, проект §12.1). Только чтение:
// версии, службы, диски, GPU, LibreOffice и шрифты, сервер модели, сеть, питание. Значения секретов и адреса
// не записываются. Итог печатается таблицей проверок; JSON — для решения D-040 (PostgreSQL, диск копий).
// Код выхода: 0 — отчёт записан (оценки — в таблице), 1 — сбой самого осмотра.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { arch, cpus, freemem, hostname, networkInterfaces, release, totalmem, type, uptime, version } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findSoffice, LibreOfficeConverter } from '../../apps/worker/src/office/libreoffice.ts';
import { argValue } from '../cli.ts';
import { collectPreflight, type ICommandResult, type IPreflightDeps } from './preflight-lib.ts';

const run = (file: string, args: string[], timeoutMs = 15_000): Promise<ICommandResult> =>
  new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      done({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(e && typeof e.code === 'string' ? { error: e.code } : {}),
      });
    });
  });

const ipv4 = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);

const deps: IPreflightDeps = {
  platform: process.platform,
  env: process.env,
  os: {
    hostname: hostname(),
    type: type(),
    release: release(),
    version: version(),
    arch: arch(),
    cpuModel: cpus()[0]?.model.trim() ?? '',
    cpuCount: cpus().length,
    totalMem: totalmem(),
    freeMem: freemem(),
    uptimeSec: uptime(),
    ipv4: ipv4(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  nodeVersion: process.version,
  run,
  exists: existsSync,
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  statfs: (p) => {
    try {
      const s = statfsSync(p);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return null;
    }
  },
  fetchJson: async (url, timeoutMs) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch (err) {
      return { error: (err as Error).name };
    }
  },
  findSoffice: () => findSoffice(process.env.SOFFICE_PATH ?? null),
  libreofficeVersion: async () => {
    const path = findSoffice(process.env.SOFFICE_PATH ?? null);
    if (!path) return null;
    try {
      return await new LibreOfficeConverter(path, 120_000).version();
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

const main = async (): Promise<void> => {
  const report = await collectPreflight(deps);
  const out = resolve(argValue('out') ?? join('artifacts', 'stage-17', 'target', `preflight-${report.host.hostname}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const width = Math.max(...report.checks.map((c) => c.id.length));
  console.log(`Осмотр ${report.host.hostname} (${report.host.os}), ${report.collectedAt}`);
  for (const c of report.checks) console.log(`${c.status.toUpperCase().padEnd(7)} ${c.id.padEnd(width)}  ${c.note}`);
  console.log(`\nотчёт: ${out}`);
};

main().catch((err: unknown) => {
  console.error(`осмотр не выполнен: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exitCode = 1;
});
