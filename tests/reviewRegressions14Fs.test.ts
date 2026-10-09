// Регрессии Review 14-1 без БД (сценарии ревью): R14-02 — перенос признака готовности без замены, когда жёсткие ссылки
// недоступны; R14-03 — служебная папка Яндекс Диска, физически лежащая внутри папки синхронизации через junction или
// символическую ссылку (на Windows — junction, на Linux — символическая ссылка на каталог). Ожидания — правильное
// поведение: на передаче 14-1 (`8c6cb90`) сценарии падают.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? 'error',
  );

describe('R14-02: признак готовности не заменяет чужой файл, когда жёсткие ссылки недоступны', () => {
  it('ссылки не поддерживаются, чужой признак появляется на границе переноса — перенос отказывает, чужие байты целы', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-02-'));
    const source = join(base, 'own.part');
    const dest = join(base, 'kontur-placement.json');
    writeFileSync(source, 'OWN-MARKER');
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs/promises')>();
      const competing = async () => {
        if (!existsSync(dest)) await real.writeFile(dest, 'COMPETING-MARKER', { flag: 'wx' });
      };
      return {
        ...real,
        link: async () => {
          throw Object.assign(new Error('жёсткие ссылки не поддерживаются (имитация ресурса)'), { code: 'ENOTSUP' });
        },
        // Любая запасная запись на место признака: чужой файл появляется прямо перед ней.
        rename: async (a: string, b: string) => {
          if (b === dest) await competing();
          return real.rename(a, b);
        },
        copyFile: async (a: string, b: string, mode?: number) => {
          if (b === dest) await competing();
          return real.copyFile(a, b, mode);
        },
      };
    });
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const code = await codeOf(nodeDeliveryFs().moveNoReplace(source, dest));
    expect(code, 'перенос без замены при недоступных ссылках должен отказывать, а не проверять имя и переименовывать').not.toBe('ok');
    if (existsSync(dest)) expect(readFileSync(dest, 'utf8')).toBe('COMPETING-MARKER');
  });

  it('контроль: обычный путь через жёсткую ссылку сохраняет существующий признак (EEXIST)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-02c-'));
    const source = join(base, 'own.part');
    const dest = join(base, 'kontur-placement.json');
    writeFileSync(source, 'OWN');
    writeFileSync(dest, 'FOREIGN');
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    expect(await codeOf(nodeDeliveryFs().moveNoReplace(source, dest))).toBe('EEXIST');
    expect(readFileSync(dest, 'utf8')).toBe('FOREIGN');
  });
});

describe('R14-02: назначение без жёстких ссылок — понятный отказ, а не перезапись', () => {
  it('размещение: папка перенесена, признак не записан, код NO_ATOMIC_MOVE без повтора; «Проверить назначение» сообщает то же', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-02p-'));
    const root = join(base, 'root');
    const staging = join(base, 'staging');
    mkdirSync(root);
    mkdirSync(staging);
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const { DeliveryAdapterError, FsDeliveryTarget, placeFolder } = await import('../packages/adapters/src/index.ts');
    const inner = nodeDeliveryFs();
    const noLinks = {
      ...inner,
      moveNoReplace: async () => {
        throw Object.assign(new Error('жёсткую ссылку создать нельзя (ENOTSUP)'), { code: 'NO_HARDLINK' });
      },
    };
    const t = new FsDeliveryTarget({ kind: 'smb', rootPath: root, stagingPath: staging, fs: noLinks });
    const body = Buffer.from('PAYLOAD');
    const marker = Buffer.from('MARKER');
    const err = await placeFolder(t, {
      own: 'own',
      targetFolder: 'T/Этап 1/Выпуск 1 x',
      files: [{ path: 'file.txt', sha256: sha(body), size: body.length, open: () => Readable.from([body]) }],
      marker: { name: 'kontur-placement.json', bytes: marker, sha256: sha(marker) },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeliveryAdapterError);
    expect(err).toMatchObject({ code: 'NO_ATOMIC_MOVE', retryable: false });
    expect(existsSync(join(root, 'T', 'Этап 1', 'Выпуск 1 x', 'kontur-placement.json'))).toBe(false);
    expect(await codeOf(t.probe())).toBe('NO_ATOMIC_MOVE');
    expect(readdirSync(root).filter((x) => x.startsWith('.kontur-probe-'))).toEqual([]);
  });
});

describe('R14-03: служебная папка физически внутри папки синхронизации', () => {
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-03-'));
    const root = join(base, 'sync');
    const physical = join(root, 'staging');
    const alias = join(base, 'staging-alias');
    // Своя служебная папка операции уже есть — допустимое состояние после прежней попытки (как в сценарии ревью).
    mkdirSync(join(physical, 'own-delivery'), { recursive: true });
    symlinkSync(physical, alias, 'junction');
    return { base, root, physical, alias };
  };

  it('размещение: отказ до записи — ни одного файла внутри синхронизируемого дерева', async () => {
    const { root, physical, alias } = setup();
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const { FsDeliveryTarget, placeFolder } = await import('../packages/adapters/src/index.ts');
    const { isPathInside } = await import('../packages/core/src/index.ts');
    expect(isPathInside(alias, root), 'по строке пути папки раздельны — поэтому и нужна физическая проверка').toBe(false);
    const inner = nodeDeliveryFs();
    let writes = 0;
    const fs = {
      ...inner,
      writeFile: async (...a: Parameters<typeof inner.writeFile>) => {
        writes += 1;
        return inner.writeFile(...a);
      },
      mkdir: async (p: string) => {
        writes += 1;
        return inner.mkdir(p);
      },
    };
    const body = Buffer.from('PAYLOAD');
    const marker = Buffer.from('MARKER');
    const code = await codeOf(
      placeFolder(new FsDeliveryTarget({ kind: 'yandex_disk', rootPath: root, stagingPath: alias, fs }), {
        own: 'own-delivery',
        targetFolder: 'Tender/Stage/Release',
        files: [{ path: 'file.txt', sha256: sha(body), size: body.length, open: () => Readable.from([body]) }],
        marker: { name: 'kontur-placement.json', bytes: marker, sha256: sha(marker) },
      }),
    );
    expect(writes, 'незавершённые файлы записаны внутрь папки синхронизации через junction').toBe(0);
    expect(code).toBe('INVALID_PATH');
    expect(readdirSync(join(physical, 'own-delivery'))).toEqual([]);
    expect(readdirSync(root)).toEqual(['staging']);
  });

  it('«Проверить назначение»: тот же отказ, пробная папка не создаётся', async () => {
    const { root, alias, physical } = setup();
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const { FsDeliveryTarget } = await import('../packages/adapters/src/index.ts');
    const t = new FsDeliveryTarget({ kind: 'yandex_disk', rootPath: root, stagingPath: alias, fs: nodeDeliveryFs() });
    expect(await codeOf(t.probe())).toBe('INVALID_PATH');
    expect(readdirSync(physical)).toEqual(['own-delivery']);
  });

  it('корень физически внутри служебной папки — отказ и у сетевой папки', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-03b-'));
    const staging = join(base, 'staging');
    mkdirSync(join(staging, 'root'), { recursive: true });
    const rootAlias = join(base, 'root-alias');
    symlinkSync(join(staging, 'root'), rootAlias, 'junction');
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const { FsDeliveryTarget } = await import('../packages/adapters/src/index.ts');
    const t = new FsDeliveryTarget({ kind: 'smb', rootPath: rootAlias, stagingPath: staging, fs: nodeDeliveryFs() });
    expect(await codeOf(t.probe())).toBe('INVALID_PATH');
  });

  it('контроль: служебная папка вне синхронизации на том же диске — проверка проходит', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-r14-03c-'));
    const root = join(base, 'sync');
    const staging = join(base, 'staging');
    mkdirSync(root);
    mkdirSync(staging);
    const { nodeDeliveryFs } = await import('../packages/storage/src/deliveryFs.ts');
    const { FsDeliveryTarget } = await import('../packages/adapters/src/index.ts');
    expect(await codeOf(new FsDeliveryTarget({ kind: 'yandex_disk', rootPath: root, stagingPath: staging, fs: nodeDeliveryFs() }).probe())).toBe('ok');
  });
});
