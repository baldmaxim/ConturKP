// Этап 17 (проект §10, U-02): настоящий HTTPS-прослушиватель тем же кодом, что у процесса server: /health по TLS 1.2+,
// HSTS, Secure у cookie, отказ клиента без доверия к корню, обычный HTTP не проходит; несовпадающая пара — отказ
// старта без содержимого ключа в журнале; проверка TLS в config:check (пара, адрес в сертификате, срок).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectTls } from '../packages/config/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { closeListener, createListener } from '../apps/server/src/listen.ts';
import { buildScenario, Clock, createTestDb, PASSWORD, testConfig, type ITestDb } from './helpers.ts';
import { selfSignedCert } from './tlsFixture.ts';

const ROOT = resolve(import.meta.dirname, '..');
let db: ITestDb;
let server: Server;
let port = 0;
const dir = mkdtempSync(join(tmpdir(), 'kontur-tls-'));
const pair = selfSignedCert({ ips: ['127.0.0.1'], dns: ['localhost'] });
const other = selfSignedCert();
writeFileSync(join(dir, 'cert.pem'), pair.certPem);
writeFileSync(join(dir, 'key.pem'), pair.keyPem);
writeFileSync(join(dir, 'other-key.pem'), other.keyPem);

interface IResp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  protocol: string | null;
}

const call = (path: string, o: { method?: string; body?: string; headers?: Record<string, string>; ca?: string | null } = {}): Promise<IResp> =>
  new Promise((done, fail) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers, ...(o.ca === null ? {} : { ca: o.ca ?? pair.certPem }) },
      (res) => {
        const protocol = (res.socket as TLSSocket | null)?.getProtocol?.() ?? null;
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body, protocol }));
      },
    );
    req.on('error', fail);
    if (o.body) req.write(o.body);
    req.end();
  });

beforeAll(async () => {
  db = await createTestDb();
  const config = testConfig({ tls: { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }, allowedOrigins: [] });
  const app = createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined });
  await buildScenario(db, createApp({ config: testConfig(), pool: db.pool, clock: new Clock().read, logError: () => undefined }));
  server = createListener(config, app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  config.allowedOrigins.push(`https://127.0.0.1:${port}`);
});
afterAll(async () => {
  await closeListener(server, 1000);
  await db.drop();
});

describe('HTTPS-прослушиватель процесса server', () => {
  it('/health по TLS 1.2 или 1.3, заголовок HSTS', async () => {
    const r = await call('/api/v1/health');
    expect(r.status).toBe(200);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(r.protocol);
    expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=\d+/u);
  });

  it('cookie сессии — Secure, HttpOnly, SameSite=Strict', async () => {
    const r = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login: 'eng1', password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: `https://127.0.0.1:${port}` },
    });
    expect(r.status, r.body).toBe(200);
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) expect(c).toMatch(/;\s*Secure/iu);
    expect(cookies.some((c) => /HttpOnly/iu.test(c) && /SameSite=Strict/iu.test(c))).toBe(true);
  });

  it('клиент без доверия к корню отказывает; обычный HTTP на порт не проходит', async () => {
    await expect(call('/api/v1/health', { ca: null })).rejects.toMatchObject({ code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/u) });
    const plain = await new Promise<number | string>((done) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/health' }, (res) => done(res.statusCode ?? 0));
      req.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
      req.end();
    });
    expect(plain === 200).toBe(false);
  });

  it('несовпадающая пара: процесс server не стартует (код 1), ключ в журнал не попадает', () => {
    const r = spawnSync(process.execPath, ['apps/server/src/main.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        KONTUR_ENV: 'test',
        DATABASE_URL: db.appUrl,
        STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-tls-storage-')),
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: '45679',
        ALLOWED_ORIGINS: 'https://127.0.0.1:3200',
        TLS_CERT_FILE: join(dir, 'cert.pem'),
        TLS_KEY_FILE: join(dir, 'other-key.pem'),
      },
    });
    expect(r.status).toBe(1);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/ошибка запуска/u);
    const keyBody = other.keyPem.split('\n')[1]!;
    expect(out).not.toContain(keyBody);
    expect(out).not.toContain('PRIVATE KEY');
  });
});

describe('config:check — TLS', () => {
  it('пара совпадает, адрес из ALLOWED_ORIGINS в сертификате, срок — без замечаний', () => {
    const t = inspectTls({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }, ['https://127.0.0.1:3200', 'https://localhost:3200']);
    expect(t.problems).toEqual([]);
    expect(t.subjectAltNames).toEqual(['DNS:localhost', 'IP Address:127.0.0.1']);
    expect(t.daysLeft).toBeGreaterThanOrEqual(29);
  });

  it('чужой ключ, адрес вне сертификата, скорое и прошедшее истечение — названы', () => {
    const wrong = inspectTls({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'other-key.pem') }, ['https://192.168.10.25:3200']);
    expect(wrong.problems.join('\n')).toMatch(/не соответствует сертификату/u);
    expect(wrong.problems.join('\n')).toMatch(/192\.168\.10\.25 из ALLOWED_ORIGINS не входит/u);
    expect(inspectTls({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }, [], new Date(Date.now() + 20 * 86_400_000)).warnings.join()).toMatch(/истекает/u);
    expect(inspectTls({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }, [], new Date(Date.now() + 60 * 86_400_000)).problems.join()).toMatch(/истёк/u);
    expect(inspectTls({ certFile: join(dir, 'нет.pem'), keyFile: join(dir, 'key.pem') }, []).problems.join()).toMatch(/не читается/u);
  });
});
