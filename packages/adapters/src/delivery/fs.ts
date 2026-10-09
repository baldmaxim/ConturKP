// Файловые операции размещения (этап 14; D-034). Узкий набор операций, через который работает FsDeliveryTarget. Пакет
// адаптеров файловую систему не трогает (A38): реализация поверх файловой системы — `nodeDeliveryFs` в @kontur/storage,
// в тестах — обёртка с внесением отказов (обрыв сети, нет прав, нет места, частичная запись, неизвестный исход). Сроки
// ожидания задаёт адаптер: у записи и переноса истечение срока означает неизвестный исход (A29).
import type { Readable } from 'node:stream';

export interface IFsStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  dev: number;
}

// Физическая идентичность объекта файловой системы (stat bigint): одинаковые dev и ino — один и тот же каталог, как
// бы к нему ни вели пути (junction, символическая ссылка, короткое имя 8.3). ino = 0 — идентичность неизвестна.
export interface IFsIdentity {
  dev: bigint;
  ino: bigint;
}

export interface IDeliveryFs {
  stat(path: string): Promise<IFsStat | null>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  // Запись потока; exclusive — не создавать поверх существующего (EEXIST).
  writeFile(path: string, source: Readable | Buffer, exclusive: boolean): Promise<void>;
  hashFile(path: string): Promise<{ sha256: string; size: number }>;
  rename(from: string, to: string): Promise<void>;
  // Перенос файла без замены: имя занято — EEXIST. rename файла и на Windows, и на POSIX заменяет существующий файл,
  // поэтому — жёсткая ссылка (атомарно, EEXIST) и удаление исходного; где ссылки не поддерживаются — проверка и rename.
  moveNoReplace(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  // Физический путь: ссылки и junction разрешены (Review 14-1 R14-03).
  realpath(path: string): Promise<string>;
  identity(path: string): Promise<IFsIdentity | null>;
}
