// Этап 06: сценарий live-smoke TenderHub (U-04) проверен против поддельного сервера — чтобы после выдачи
// ключа запускался готовый и проверенный скрипт. Живым прогоном это не является: статус остаётся
// VERIFIED_FIXTURE, live-smoke — NOT_RUN до U-04.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { standardTender, TH, TH_KEY } from './calculationFixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OTHER_TENDER = '7d1f0c8e-1111-4a6b-9c1d-0000000000ff';
let hub: IFakeTenderHub;
let dir: string;

beforeAll(async () => {
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.pageSize = 2;
  hub.tenders.set(TH.tender, standardTender());
  hub.tenders.set(OTHER_TENDER, standardTender(OTHER_TENDER, 'TH-2026-099'));
  dir = mkdtempSync(join(tmpdir(), 'kontur-th-live-'));
});
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

// Окружение процесса — только переменные TenderHub: без БД и прочей конфигурации портала.
const run = (env: Record<string, string>, tender: string, name: string): Promise<{ code: number | null; out: string; log: string }> =>
  new Promise((done) => {
    const out = join(dir, `${name}.log`);
    const p = spawn(process.execPath, ['scripts/tenderhub-live-smoke.ts', '--tender', tender, '--out', out], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('close', (code) => {
      let log = '';
      try {
        log = readFileSync(out, 'utf8');
      } catch {
        // журнал не записан
      }
      done({ code, out: text, log });
    });
  });

describe('live-smoke TenderHub (U-04) — сценарий на поддельном сервере', () => {
  it('без адреса и ключа — NOT_RUN с кодом 3, запросов нет', async () => {
    hub.requests.length = 0;
    const r = await run({}, TH.tender, 'not-run');
    expect(r.code, r.out).toBe(3);
    expect(r.log).toMatch(/TENDERHUB_API_KEY не задан/u);
    expect(r.log).toMatch(/Итог: NOT_RUN/u);
    expect(hub.requests).toHaveLength(0);
  });

  it('разрешённый тендер: OpenAPI сверена, выгрузка согласована, только GET с X-API-Key; ключа и данных тендера в журнале нет', async () => {
    hub.requests.length = 0;
    hub.specOmitFields = ['client_note'];
    const r = await run({ TENDERHUB_URL: hub.url, TENDERHUB_API_KEY: TH_KEY }, TH.tender, 'pass');
    hub.specOmitFields = [];
    expect(r.code, r.out).toBe(0);
    expect(r.log).toMatch(/PASS {2}OpenAPI развёрнутой сборки получена — \/api\/v1\/archive\/openapi\.yaml, SHA-256 [0-9a-f]{64}, версия 1\.0\.0-fake/u);
    expect(r.log).toMatch(/PASS {2}маршруты адаптера описаны в OpenAPI — 5 из 5/u);
    expect(r.log).toMatch(/PASS {2}выгрузка тендера по X-API-Key — .*страниц позиций 2, позиций 4, строк 3/u);
    expect(r.log).toMatch(/PASS {2}сверка до\/после и между маршрутами — consistent/u);
    expect(r.log).toMatch(/PASS {2}gzip в ответах/u);
    // Расхождение сборки со спецификацией показывается, а не скрывается (R-06).
    expect(r.log).toMatch(/^INFO {2}поля ответов описаны в OpenAPI — не найдены в спецификации: client_note$/mu);
    expect(r.log).toMatch(/Итог: PASS/u);
    // Ключ, названия и цены тендера в журнал и вывод не попадают.
    for (const text of [r.log, r.out]) {
      expect(text).not.toContain(TH_KEY);
      expect(text).not.toContain('ЖК «Северный»');
      expect(text).not.toContain('Бетонирование');
      expect(text).not.toContain('123456789012345.678901');
    }
    expect(hub.requests.length).toBeGreaterThan(0);
    expect(hub.requests.every((q) => q.method === 'GET' && q.apiKey === TH_KEY && q.authorization === undefined)).toBe(true);
    // Читается только указанный тендер (плюс спецификация и поиск его номера в brief).
    expect(hub.requests.every((q) => q.path.includes(TH.tender) || q.path.startsWith('/api/v1/archive/openapi.yaml') || q.path.startsWith('/api/v1/tenders/brief'))).toBe(true);
  });

  it('тендер вне списка ключа — FAIL с forbidden_tender, код 1', async () => {
    hub.allowedTenders = [TH.tender];
    const r = await run({ TENDERHUB_URL: hub.url, TENDERHUB_API_KEY: TH_KEY }, OTHER_TENDER, 'forbidden');
    hub.allowedTenders = null;
    expect(r.code, r.out).toBe(1);
    expect(r.log).toMatch(/FAIL {2}выгрузка тендера по X-API-Key — FORBIDDEN\/forbidden_tender/u);
    expect(r.log).not.toContain(TH_KEY);
  });

  it('неверный ключ — FAIL с auth_failed; ключ не печатается', async () => {
    const wrong = 'thk_wrong_0000000000000000';
    const r = await run({ TENDERHUB_URL: hub.url, TENDERHUB_API_KEY: wrong }, TH.tender, 'auth');
    expect(r.code, r.out).toBe(1);
    expect(r.log).toMatch(/AUTH_FAILED\/auth_failed/u);
    expect(`${r.log}${r.out}`).not.toContain(wrong);
  });
});
