// Адаптер размещения поверх файловой системы (этап 14; D-034; проект §4). Оба назначения — файловые: корень Яндекс Диска —
// путь внутри локальной папки синхронизации (синхронизацию с облаком выполняет клиент Яндекс Диска), корень сетевой папки —
// UNC-путь. Корень и служебная папка — только из закреплённой версии назначения (R01-05). Адаптер ничего не удаляет вне
// служебной папки доставки, ничего не перезаписывает в папке выпуска и ничего не публикует.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isPathInside } from '@kontur/core';
import type { Readable } from 'node:stream';
import { DeliveryAdapterError, deliveryErrorOf, withTimeout } from './errors.ts';
import type { IDeliveryFs, IFsIdentity } from './fs.ts';

export type DeliveryTargetKind = 'yandex_disk' | 'smb';
export type Where = 'root' | 'staging';

export interface IRemoteFile {
  type: 'file';
  size: number;
  sha256: string;
}
export type RemoteEntry = IRemoteFile | { type: 'dir' };

export interface ILocalFile {
  sha256: string;
  size: number;
  open: () => Readable;
}

export interface IDeliveryTargetOptions {
  kind: DeliveryTargetKind;
  rootPath: string;
  stagingPath: string;
  fs: IDeliveryFs;
  // Срок ожидания одной операции (мс); запись файла — пропорционально размеру.
  timeoutMs?: number;
}

const PROBE_PREFIX = '.kontur-probe-';
export const DEFAULT_STAGING_NAME = '.kontur-staging';

// Служебная папка по умолчанию — <корень>/.kontur-staging (сетевая папка): её создаёт портал. Явно заданную служебную
// папку портал не создаёт: опечатка в пути не должна превращаться в новую папку.
const isDefaultStaging = (root: string, staging: string): boolean => {
  const r = root.replace(/[\\/]+$/u, '');
  return staging === `${r}/${DEFAULT_STAGING_NAME}` || staging === `${r}\\${DEFAULT_STAGING_NAME}`;
};

export class FsDeliveryTarget {
  readonly kind: DeliveryTargetKind;
  private readonly o: Required<IDeliveryTargetOptions>;

  constructor(o: IDeliveryTargetOptions) {
    this.kind = o.kind;
    this.o = { timeoutMs: 60_000, ...o };
  }

  private abs(where: Where, rel: string): string {
    const base = where === 'root' ? this.o.rootPath : this.o.stagingPath;
    return rel === '' ? base : join(base, ...rel.split('/'));
  }

  private async run<T>(op: string, mutating: boolean, fn: () => Promise<T>, ms = this.o.timeoutMs): Promise<T> {
    try {
      return await withTimeout(op, ms, fn);
    } catch (err) {
      throw deliveryErrorOf(err, op, mutating);
    }
  }

  private writeTimeout(size: number): number {
    // Не меньше базового срока; на каждый мегабайт — ещё 2 секунды (медленная сеть).
    return this.o.timeoutMs + Math.ceil(size / 1_048_576) * 2_000;
  }

  // Корень и служебная папка существуют; корень — папка.
  async checkBases(): Promise<{ rootDev: number; stagingDev: number }> {
    const root = await this.run('проверка корня', false, () => this.o.fs.stat(this.o.rootPath));
    if (!root || !root.isDirectory) throw new DeliveryAdapterError('ROOT_NOT_FOUND', 'корень назначения не найден или это не папка');
    let staging = await this.run('проверка служебной папки', false, () => this.o.fs.stat(this.o.stagingPath));
    if (!staging && isDefaultStaging(this.o.rootPath, this.o.stagingPath)) {
      await this.ensureFolder('root', DEFAULT_STAGING_NAME);
      staging = await this.run('проверка служебной папки', false, () => this.o.fs.stat(this.o.stagingPath));
    }
    if (!staging || !staging.isDirectory) throw new DeliveryAdapterError('STAGING_NOT_FOUND', 'служебная папка назначения не найдена или это не папка');
    await this.checkPhysicalSeparation();
    return { rootDev: root.dev, stagingDev: staging.dev };
  }

  // Физическое разделение корня и служебной папки (Review 14-1 R14-03): строки путей могут различаться, а каталог — быть
  // тем же (junction, символическая ссылка, короткое имя). Сверяются разрешённые пути и идентичность (dev + ino) каждого
  // родителя. Корень внутри служебной папки — отказ у любого назначения; служебная папка внутри корня — у Яндекс Диска
  // (у сетевой папки служебная по умолчанию лежит в корне). Проверка — до любой записи.
  private async checkPhysicalSeparation(): Promise<void> {
    const root = await this.run('проверка корня', false, () => this.o.fs.realpath(this.o.rootPath));
    const staging = await this.run('проверка служебной папки', false, () => this.o.fs.realpath(this.o.stagingPath));
    const rootId = await this.run('проверка корня', false, () => this.o.fs.identity(root));
    const stagingId = await this.run('проверка служебной папки', false, () => this.o.fs.identity(staging));
    if (isPathInside(root, staging) || (await this.hasAncestor(root, stagingId))) {
      throw new DeliveryAdapterError('INVALID_PATH', 'корень назначения физически лежит внутри служебной папки (ссылка или junction)');
    }
    if (this.kind === 'yandex_disk' && (isPathInside(staging, root) || (await this.hasAncestor(staging, rootId)))) {
      throw new DeliveryAdapterError('INVALID_PATH', 'служебная папка физически лежит внутри папки синхронизации (ссылка или junction): незавершённые файлы ушли бы в облако');
    }
  }

  // Путь p или один из его родителей — тот же каталог, что id. Неизвестная идентичность (ino = 0, сетевые ресурсы) или
  // недоступный родитель — проверка по разрешённому пути остаётся единственной.
  private async hasAncestor(p: string, id: IFsIdentity | null): Promise<boolean> {
    if (!id || id.ino === 0n) return false;
    for (let cur = p; ; ) {
      const here = await this.o.fs.identity(cur).catch(() => null);
      if (here && here.dev === id.dev && here.ino === id.ino) return true;
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  }

  // Проверка доступа учётной записи процесса (D-034): физическое разделение корня и служебной папки, запись и чтение в
  // служебной папке, перенос пробной папки в корень и обратно (тот же том, права записи в корне), перенос файла без
  // замены жёсткой ссылкой (так переносится признак готовности, R14-02), удаление. В корне пробная папка живёт доли секунды.
  async probe(): Promise<void> {
    const bases = await this.checkBases();
    if (bases.rootDev !== bases.stagingDev) throw new DeliveryAdapterError('CROSS_DEVICE', 'служебная папка и корень на разных томах');
    const name = `${PROBE_PREFIX}${randomUUID()}`;
    const inStaging = this.abs('staging', name);
    const inRoot = this.abs('root', name);
    const body = Buffer.from(`kontur probe ${name}\n`, 'utf8');
    try {
      await this.run('создание пробной папки', true, () => this.o.fs.mkdir(inStaging));
      await this.run('запись пробного файла', true, () => this.o.fs.writeFile(join(inStaging, 'probe.txt'), body, true));
      const h = await this.run('чтение пробного файла', false, () => this.o.fs.hashFile(join(inStaging, 'probe.txt')));
      if (h.size !== body.length) throw new DeliveryAdapterError('UNAVAILABLE', 'пробный файл прочитан не полностью');
      await this.run('перенос пробной папки в корень', true, () => this.o.fs.rename(inStaging, inRoot));
      await this.run('перенос пробной папки обратно', true, () => this.o.fs.rename(inRoot, inStaging));
      await this.run('создание пробной папки в корне', true, () => this.o.fs.mkdir(inRoot));
      await this.run('перенос файла без замены', true, () => this.o.fs.moveNoReplace(join(inStaging, 'probe.txt'), join(inRoot, 'probe.txt')));
    } finally {
      await this.o.fs.remove(inStaging).catch(() => undefined);
      await this.o.fs.remove(inRoot).catch(() => undefined);
    }
  }

  // Что лежит по пути: файл (размер и SHA-256 — чтение назад), папка или ничего.
  async inspect(where: Where, rel: string): Promise<RemoteEntry | null> {
    const p = this.abs(where, rel);
    const s = await this.run('чтение назначения', false, () => this.o.fs.stat(p));
    if (!s) return null;
    if (s.isDirectory) return { type: 'dir' };
    const h = await this.run('сверка файла', false, () => this.o.fs.hashFile(p), this.writeTimeout(s.size));
    return { type: 'file', size: h.size, sha256: h.sha256 };
  }

  async list(where: Where, rel: string): Promise<string[]> {
    return this.run('перечень папки', false, () => this.o.fs.readdir(this.abs(where, rel)));
  }

  // Папки по уровням; существующая папка — не ошибка, файл на месте папки — конфликт.
  async ensureFolder(where: Where, rel: string): Promise<void> {
    const parts = rel.split('/').filter((x) => x !== '');
    for (let i = 1; i <= parts.length; i += 1) {
      const p = this.abs(where, parts.slice(0, i).join('/'));
      const s = await this.run('чтение назначения', false, () => this.o.fs.stat(p));
      if (s?.isDirectory) continue;
      if (s) throw new DeliveryAdapterError('CONFLICT', 'на месте папки лежит файл');
      try {
        await this.run('создание папки', true, () => this.o.fs.mkdir(p));
      } catch (err) {
        if (err instanceof DeliveryAdapterError && err.code === 'CONFLICT') {
          const again = await this.run('чтение назначения', false, () => this.o.fs.stat(p));
          if (again?.isDirectory) continue;
        }
        throw err;
      }
    }
  }

  // Файл в служебной папке доставки: запись в .part, перенос на имя, чтение назад. Служебная папка принадлежит доставке —
  // свой незавершённый файл перезаписывается.
  async putStagingFile(rel: string, file: ILocalFile): Promise<IRemoteFile> {
    const target = this.abs('staging', rel);
    const part = `${target}.part`;
    await this.run('запись файла', true, () => this.o.fs.writeFile(part, file.open(), false), this.writeTimeout(file.size));
    await this.run('переименование файла', true, () => this.o.fs.rename(part, target));
    const e = await this.inspect('staging', rel);
    if (!e || e.type !== 'file') throw new DeliveryAdapterError('UNAVAILABLE', 'записанный файл не найден при сверке');
    return e;
  }

  // Перенос служебной папки доставки в папку выпуска без замены: папка выпуска уже есть — target_exists.
  async commitFolder(stagingRel: string, targetRel: string): Promise<'moved' | 'target_exists'> {
    if (await this.inspectQuick('root', targetRel)) return 'target_exists';
    const parent = targetRel.split('/').slice(0, -1).join('/');
    if (parent) await this.ensureFolder('root', parent);
    try {
      await this.run('перенос в папку выпуска', true, () => this.o.fs.rename(this.abs('staging', stagingRel), this.abs('root', targetRel)));
      return 'moved';
    } catch (err) {
      // Папка выпуска появилась между проверкой и переносом: Windows отказывает, POSIX — для непустой папки.
      if (err instanceof DeliveryAdapterError && (err.code === 'CONFLICT' || err.code === 'FORBIDDEN') && (await this.inspectQuick('root', targetRel))) {
        return 'target_exists';
      }
      throw err;
    }
  }

  // Признак готовности — последним и без перезаписи: запись в служебной папке, затем перенос на имя признака без замены
  // (занято — exists; вызывающий сверяет содержимое).
  async putMarker(targetRel: string, markerName: string, ownStagingRel: string, bytes: Buffer): Promise<'written' | 'exists'> {
    const finalRel = `${targetRel}/${markerName}`;
    if (await this.inspectQuick('root', finalRel)) return 'exists';
    await this.ensureFolder('staging', ownStagingRel);
    const partRel = `${ownStagingRel}/${markerName}.part`;
    await this.run('запись признака готовности', true, () => this.o.fs.writeFile(this.abs('staging', partRel), bytes, false));
    try {
      await this.run('перенос признака готовности', true, () => this.o.fs.moveNoReplace(this.abs('staging', partRel), this.abs('root', finalRel)));
    } catch (err) {
      if (err instanceof DeliveryAdapterError && err.code === 'CONFLICT') return 'exists';
      throw err;
    }
    return 'written';
  }

  // Удаление своей служебной папки доставки (и только её).
  async removeOwnStaging(ownStagingRel: string): Promise<void> {
    if (ownStagingRel === '' || ownStagingRel.includes('/') || ownStagingRel.startsWith('.')) throw new DeliveryAdapterError('INVALID_PATH', 'служебная папка доставки задана неверно');
    await this.run('удаление служебной папки', true, () => this.o.fs.remove(this.abs('staging', ownStagingRel)));
  }

  async removeOwnStagingFile(ownStagingRel: string, rel: string): Promise<void> {
    await this.run('удаление незавершённого файла', true, () => this.o.fs.remove(this.abs('staging', `${ownStagingRel}/${rel}`)));
  }

  private async inspectQuick(where: Where, rel: string): Promise<boolean> {
    return (await this.run('чтение назначения', false, () => this.o.fs.stat(this.abs(where, rel)))) !== null;
  }
}
