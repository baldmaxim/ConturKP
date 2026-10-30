/** Уведомляем только об отличии загруженной сборки от опубликованной на сервере. */
export class AppVersionMonitor {
  private deployedVersion: string | null = null;
  private dismissedVersion: string | null = null;
  private availableVersion: string | null = null;
  private pending: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly currentVersion: string;
  private readonly fetcher: typeof fetch;

  constructor(currentVersion: string, fetcher: typeof fetch = fetch) {
    this.currentVersion = currentVersion;
    this.fetcher = fetcher;
  }

  getSnapshot = (): string | null => this.availableVersion;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  dismiss = (): void => {
    this.dismissedVersion = this.deployedVersion;
    this.publish();
  };

  check = (): Promise<void> => {
    if (!this.currentVersion) return Promise.resolve();
    if (!this.pending) this.pending = this.readVersion().finally(() => { this.pending = null; });
    return this.pending;
  };

  private async readVersion(): Promise<void> {
    try {
      // Нативный window.fetch нельзя вызывать с экземпляром монитора в качестве this.
      const fetcher = this.fetcher;
      const response = await fetcher('/api/ui-version', {
        cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return;
      const manifest: unknown = await response.json();
      if (!manifest || typeof manifest !== 'object' || !('version' in manifest)
        || typeof manifest.version !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(manifest.version)) return;
      this.deployedVersion = manifest.version;
      this.publish();
    } catch {
      // Сбой сети или недоступный манифест не доказывает наличие новой сборки.
    }
  }

  private publish(): void {
    const next = this.deployedVersion !== this.currentVersion && this.deployedVersion !== this.dismissedVersion
      ? this.deployedVersion : null;
    if (next === this.availableVersion) return;
    this.availableVersion = next;
    this.listeners.forEach((listener) => listener());
  }
}
