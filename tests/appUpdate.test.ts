import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUpdateRouter } from '../apps/server/src/appUpdate.ts';
import { restoreAppUpdateLocation, shouldRegisterAppWorker } from '../apps/web/src/utils/appUpdateLocation.ts';

const origin = 'https://portal.test:3200';
const script = readFileSync(new URL('../apps/web/public/app-update.js', import.meta.url), 'utf8');
const target = '/stages/original?tab=economics#totals';
const shellTarget = (returnTo: string) => `/api/ui-update-shell?returnTo=${encodeURIComponent(returnTo)}`;
const appRegistration = () => ({
  scope: `${origin}/`,
  active: { scriptURL: `${origin}/sw.js` },
  waiting: null,
  installing: null,
  unregister: vi.fn().mockResolvedValue(true),
});

const loadPage = (serviceWorker?: { getRegistration: ReturnType<typeof vi.fn>; register?: ReturnType<typeof vi.fn> }, returnTo = target) => {
  const elements = {
    'update-status': { textContent: '' },
    'update-retry': { hidden: true, addEventListener: vi.fn() },
    'update-back': { href: '/' },
  };
  const replace = vi.fn();
  const service = serviceWorker;
  runInNewContext(script, {
    URL,
    URLSearchParams,
    navigator: service ? { serviceWorker: service } : {},
    window: { location: { origin, search: `?returnTo=${encodeURIComponent(returnTo)}`, replace } },
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    setTimeout,
    clearTimeout,
  });
  return { elements, replace, service };
};

afterEach(() => vi.useRealTimers());

describe('browser update recovery', () => {
  it('returns to the same calculation without requiring Service Worker support', () => {
    const page = loadPage();
    expect(page.replace).toHaveBeenCalledWith(shellTarget(target));
    expect(page.elements['update-back'].href).toBe(target);
  });

  it('removes only the portal registration before loading the fresh document', async () => {
    let finish!: (value: boolean) => void;
    const registration = appRegistration();
    registration.unregister.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const serviceWorker = { getRegistration: vi.fn().mockResolvedValue(registration) };
    const page = loadPage(serviceWorker);
    await vi.waitFor(() => expect(registration.unregister).toHaveBeenCalledOnce());
    expect(serviceWorker.getRegistration).toHaveBeenCalledWith(`${origin}/`);
    expect(page.replace).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(page.replace).toHaveBeenCalledWith(shellTarget(target)));
  });

  it.each([
    { scope: `${origin}/another/`, active: { scriptURL: `${origin}/sw.js` } },
    { scope: `${origin}/`, active: { scriptURL: `${origin}/another-worker.js` } },
  ])('preserves unrelated worker registrations: $scope $active.scriptURL', async (other) => {
    const registration = { ...appRegistration(), ...other };
    const page = loadPage({ getRegistration: vi.fn().mockResolvedValue(registration) });
    await vi.waitFor(() => expect(page.replace).toHaveBeenCalledWith(shellTarget(target)));
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it('offers a working retry after a registration error instead of hanging', async () => {
    const getRegistration = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(appRegistration());
    const page = loadPage({ getRegistration });
    await vi.waitFor(() => expect(page.elements['update-retry'].hidden).toBe(false));
    expect(page.replace).not.toHaveBeenCalled();
    expect(page.elements['update-status'].textContent).toContain('Не удалось обновить');
    const retry = page.elements['update-retry'].addEventListener.mock.calls[0]![1] as () => void;
    retry();
    await vi.waitFor(() => expect(page.replace).toHaveBeenCalledWith(shellTarget(target)));
    expect(getRegistration).toHaveBeenCalledTimes(2);
  });

  it.each(['lookup', 'unregister'])('stops a stalled %s and enables retry within eight seconds', async (step) => {
    vi.useFakeTimers();
    const registration = appRegistration();
    const never = new Promise(() => {});
    if (step === 'unregister') registration.unregister.mockReturnValue(never);
    const page = loadPage({ getRegistration: vi.fn().mockResolvedValue(step === 'lookup' ? never : registration) });
    await vi.runAllTimersAsync();
    expect(page.elements['update-retry'].hidden).toBe(false);
    expect(page.elements['update-status'].textContent).toContain('Не удалось обновить');
    expect(page.replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['https://outside.test/steal', '//outside.test/', 'javascript:alert(1)', '/api/ui-update?returnTo=/api/ui-update'])('rejects unsafe or looping return addresses: %s', (returnTo) => {
    const page = loadPage(undefined, returnTo);
    expect(page.replace).toHaveBeenCalledWith(shellTarget('/'));
    expect(page.elements['update-back'].href).toBe('/');
  });
});

describe('fresh document return location', () => {
  it('keeps the updated tab on the network across reloads and permits registration in a new tab session', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(shouldRegisterAppWorker(storage, false)).toBe(true);
    expect(shouldRegisterAppWorker(storage, true)).toBe(false);
    expect(shouldRegisterAppWorker(storage, false)).toBe(false);
    expect(shouldRegisterAppWorker(storage, false)).toBe(false);
    values.clear();
    expect(shouldRegisterAppWorker(storage, false)).toBe(true);
  });

  it('keeps network access working when browser storage is unavailable', () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(shouldRegisterAppWorker(storage, true)).toBe(false);
    expect(shouldRegisterAppWorker(storage, false)).toBe(false);
  });

  it('restores the calculation route, tab and hash before app startup', () => {
    const history = { replaceState: vi.fn() };
    expect(restoreAppUpdateLocation({ pathname: '/api/ui-update-shell', search: `?returnTo=${encodeURIComponent(target)}`, origin }, history)).toBe(true);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', target);
  });

  it('leaves ordinary portal pages alone', () => {
    const history = { replaceState: vi.fn() };
    expect(restoreAppUpdateLocation({ pathname: '/stages/original', search: '?returnTo=https://outside.test', origin }, history)).toBe(false);
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it.each(['https://outside.test/', '//outside.test/', 'javascript:alert(1)', '/api/ui-update-shell', 'http://['])('rejects unsafe startup return addresses: %s', (returnTo) => {
    const history = { replaceState: vi.fn() };
    restoreAppUpdateLocation({ pathname: '/api/ui-update-shell', search: `?returnTo=${encodeURIComponent(returnTo)}`, origin }, history);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});

describe('network-only update files', () => {
  const app = express().use('/api', appUpdateRouter(resolve('apps/web/public')));

  it.each([
    ['/api/ui-update', 'text/html', 'Обновляем портал'],
    ['/api/ui-update.js', 'javascript', 'registration.unregister()'],
    ['/api/ui-update.css', 'text/css', 'font-family'],
  ])('serves %s without caching or authentication data', async (url, contentType, content) => {
    const response = await request(app).get(url!).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain(contentType);
    expect(response.text).toContain(content);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('keeps other API routes outside the static update page', async () => {
    await request(app).get('/api/ui-update/unknown').expect(404);
  });

  it('loads the latest app document through a route excluded from old navigation caches', async () => {
    const shellApp = express().use('/api', appUpdateRouter(resolve('apps/web')));
    const response = await request(shellApp).get('/api/ui-update-shell?returnTo=/stages/original').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('/src/main.tsx');
    expect(response.headers['content-type']).toContain('text/html');
  });
});

describe('network-only deployed build version', () => {
  it('reads each deployed release from disk without restarting or caching', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'portal-version-'));
    try {
      const app = express().use('/api', appUpdateRouter(dist));
      for (const version of ['build-1', 'build-2']) {
        writeFileSync(join(dist, 'version.json'), JSON.stringify({ version, privateData: 'must-not-be-returned' }));
        const response = await request(app).get('/api/ui-version').expect(200);
        expect(response.body).toEqual({ version });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      rmSync(dist, { recursive: true });
    }
  });

  it('fails closed when release metadata is missing or damaged', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'portal-version-'));
    try {
      const app = express().use('/api', appUpdateRouter(dist));
      app.use((error: { status: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.status).json({ error: true });
      });
      await request(app).get('/api/ui-version').expect(503);
      for (const data of ['not json', '{}', '{"version":123}', '{"version":""}', 'null']) {
        writeFileSync(join(dist, 'version.json'), data);
        const response = await request(app).get('/api/ui-version').expect(503);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    } finally {
      rmSync(dist, { recursive: true });
    }
  });
});
