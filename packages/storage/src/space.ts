// Свободное место хранилища (этап 17, ADR-011 §10, проект §6): предупреждение у порога warn, остановка записи у порога
// stop — с явной ошибкой до исчерпания места, а не сбоем на середине файла. statfs внедряется (тесты, UNC и junction
// на Windows измеряются по физическому пути); не удалось измерить — уровень unknown, запись не блокируется.
import { statfs } from 'node:fs/promises';

export type SpaceLevel = 'ok' | 'warn' | 'stop' | 'unknown';

export interface ISpacePolicy {
  warnFreeBytes: number;
  stopFreeBytes: number;
  statfs?: (path: string) => Promise<{ freeBytes: number; totalBytes: number } | null>;
}

export class StorageFullError extends Error {
  readonly code = 'storage_full';
  readonly freeBytes: number | null;
  constructor(freeBytes: number | null, stopBytes: number) {
    super(
      freeBytes === null
        ? 'в хранилище закончилось место'
        : `в хранилище свободно ${Math.floor(freeBytes / 1024 ** 2)} МБ — ниже порога остановки записи ${Math.floor(stopBytes / 1024 ** 2)} МБ`,
    );
    this.freeBytes = freeBytes;
  }
}

export const isStorageFull = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof StorageFullError || code === 'ENOSPC' || code === 'EDQUOT';
};

const nodeStatfs = async (p: string): Promise<{ freeBytes: number; totalBytes: number } | null> => {
  try {
    const s = await statfs(p);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
};

const CACHE_MS = 2000;

export class FreeSpaceGuard {
  private readonly policy: ISpacePolicy;
  private readonly root: () => string;
  private cached: { at: number; freeBytes: number | null } | null = null;

  constructor(root: () => string, policy: ISpacePolicy) {
    this.root = root;
    this.policy = policy;
  }

  get enabled(): boolean {
    return this.policy.warnFreeBytes > 0 || this.policy.stopFreeBytes > 0;
  }

  async freeBytes(fresh = false): Promise<number | null> {
    if (!fresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.freeBytes;
    const s = await (this.policy.statfs ?? nodeStatfs)(this.root());
    this.cached = { at: Date.now(), freeBytes: s?.freeBytes ?? null };
    return this.cached.freeBytes;
  }

  // incoming — сколько ещё будет записано (известный размер загрузки).
  async level(incoming = 0, fresh = false): Promise<{ level: SpaceLevel; freeBytes: number | null }> {
    if (!this.enabled) return { level: 'ok', freeBytes: null };
    const free = await this.freeBytes(fresh);
    if (free === null) return { level: 'unknown', freeBytes: null };
    const left = free - incoming;
    if (this.policy.stopFreeBytes > 0 && left < this.policy.stopFreeBytes) return { level: 'stop', freeBytes: free };
    if (this.policy.warnFreeBytes > 0 && left < this.policy.warnFreeBytes) return { level: 'warn', freeBytes: free };
    return { level: 'ok', freeBytes: free };
  }

  async assertWritable(incoming = 0, fresh = false): Promise<void> {
    const l = await this.level(incoming, fresh);
    if (l.level === 'stop') throw new StorageFullError(l.freeBytes, this.policy.stopFreeBytes);
  }
}
