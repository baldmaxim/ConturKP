import { describe, expect, it, vi } from 'vitest';
import { AppVersionMonitor } from '../apps/web/src/utils/appVersion.ts';

const response = (version: string) => new Response(JSON.stringify({ version }));

describe('available portal version', () => {
  it('calls the browser fetch without binding it to the monitor instance', async () => {
    const fetcher = vi.fn(function (this: unknown): Promise<Response> {
      expect(this).toBeUndefined();
      return Promise.resolve(response('build-next'));
    });
    const monitor = new AppVersionMonitor('build-current', fetcher);
    await monitor.check();
    expect(monitor.getSnapshot()).toBe('build-next');
  });

  it('ignores repeated stale SW signals when the loaded build matches the server', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response('build-current'));
    const monitor = new AppVersionMonitor('build-current', fetcher);
    const changed = vi.fn();
    monitor.subscribe(changed);
    await monitor.check();
    await monitor.check();
    expect(monitor.getSnapshot()).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith('/api/ui-version', {
      cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
    });
  });

  it('detects a real new build without depending on a Service Worker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('build-next'));
    const monitor = new AppVersionMonitor('build-current', fetcher);
    const changed = vi.fn();
    const unsubscribe = monitor.subscribe(changed);
    await monitor.check();
    expect(monitor.getSnapshot()).toBe('build-next');
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    monitor.dismiss();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('stays hidden after the browser has successfully loaded the deployed build', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response('build-next'));
    const oldPage = new AppVersionMonitor('build-old', fetcher);
    await oldPage.check();
    expect(oldPage.getSnapshot()).toBe('build-next');
    const refreshedPage = new AppVersionMonitor('build-next', fetcher);
    await refreshedPage.check();
    await refreshedPage.check();
    expect(refreshedPage.getSnapshot()).toBeNull();
  });

  it('dismisses only the announced release and announces the following release', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response('build-2'))
      .mockResolvedValueOnce(response('build-2'))
      .mockResolvedValueOnce(response('build-3'))
      .mockResolvedValueOnce(response('build-1'));
    const monitor = new AppVersionMonitor('build-1', fetcher);
    await monitor.check();
    monitor.dismiss();
    expect(monitor.getSnapshot()).toBeNull();
    await monitor.check();
    expect(monitor.getSnapshot()).toBeNull();
    await monitor.check();
    expect(monitor.getSnapshot()).toBe('build-3');
    await monitor.check();
    expect(monitor.getSnapshot()).toBeNull();
  });

  it('does not mistake network failures or invalid manifests for a release and can retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('not JSON'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 123 })))
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(response('build-next'));
    const monitor = new AppVersionMonitor('build-current', fetcher);
    for (let i = 0; i < 6; i += 1) {
      await monitor.check();
      expect(monitor.getSnapshot()).toBeNull();
    }
    await monitor.check();
    expect(monitor.getSnapshot()).toBe('build-next');
  });

  it('shares an in-flight request between focus, timer and SW checks', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const monitor = new AppVersionMonitor('build-current', fetcher);
    const first = monitor.check();
    const second = monitor.check();
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(response('build-next'));
    await first;
    expect(monitor.getSnapshot()).toBe('build-next');
  });

  it('does not announce updates in a development document without a build marker', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const monitor = new AppVersionMonitor('', fetcher);
    await monitor.check();
    expect(fetcher).not.toHaveBeenCalled();
    expect(monitor.getSnapshot()).toBeNull();
  });
});
