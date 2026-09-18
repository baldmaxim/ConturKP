import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, newUuid } from '../api/client';
import { describeError, hasCode } from '../api/errors';
import type { IImportBatch } from '../api/types';
import { uploadImport, type IUploadHandle } from '../api/upload';
import { useUnsavedChanges } from './unsavedChanges';

export type TUploadStatus = 'queued' | 'uploading' | 'accepted' | 'error';

export interface IUploadEntry {
  id: string;
  name: string;
  size: number;
  status: TUploadStatus;
  /** Доля отправленного, 0…1. */
  progress: number;
  error: string | null;
  batch: IImportBatch | null;
}

export interface IUploadQueue {
  entries: IUploadEntry[];
  add: (files: Iterable<File>) => void;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

interface ISource {
  file: File;
  /** Ключ идемпотентности файла: повтор после сетевой ошибки идёт с тем же ключом. */
  key: string;
}

const describeUploadError = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return describeError(error);
  }
  const detail = error.problem?.detail;
  if (error.isNetwork) {
    return 'Нет связи с сервером. «Повторить» отправит файл с тем же ключом — второй партии не будет.';
  }
  switch (error.status) {
    case 413:
      return `Файл слишком большой${detail ? `: ${detail}` : ''}.`;
    case 400:
      return `Сервер отклонил загрузку${detail ? `: ${detail}` : ''}.`;
    case 403:
      return 'Нет права загружать источники в этот тендер.';
    case 404:
      return 'Этап не найден или нет доступа.';
    default:
      return describeError(error);
  }
};

/**
 * Очередь загрузки файлов в этап: по одному файлу за раз, прогресс отправки, повтор с тем же ключом.
 * Живёт на странице этапа (переживает смену вкладок); при уходе со страницы текущая отправка прерывается.
 */
export const useUploadQueue = (stageId: string, onAccepted: (batch: IImportBatch) => void): IUploadQueue => {
  const [entries, setEntries] = useState<IUploadEntry[]>([]);
  const sources = useRef(new Map<string, ISource>());
  const current = useRef<{ id: string; handle: IUploadHandle } | null>(null);
  const onAcceptedRef = useRef(onAccepted);
  onAcceptedRef.current = onAccepted;

  const patch = useCallback((id: string, changes: Partial<IUploadEntry>): void => {
    setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
  }, []);

  const busy = entries.some((entry) => entry.status === 'uploading');
  const nextId = entries.find((entry) => entry.status === 'queued')?.id ?? null;
  useUnsavedChanges(busy || nextId !== null);

  useEffect(() => {
    if (busy || !nextId) {
      return;
    }
    const source = sources.current.get(nextId);
    if (!source) {
      patch(nextId, { status: 'error', error: 'Файл больше недоступен. Выберите его заново.' });
      return;
    }
    const id = nextId;
    const handle = uploadImport(stageId, source.file, source.key, (fraction) => patch(id, { progress: fraction }));
    current.current = { id, handle };
    patch(id, { status: 'uploading', progress: 0, error: null });
    handle.promise
      .then((batch) => {
        sources.current.delete(id);
        patch(id, { status: 'accepted', progress: 1, batch });
        onAcceptedRef.current(batch);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
          // Ключ занят другим содержимым — следующая попытка пойдёт с новым ключом.
          source.key = newUuid();
        }
        patch(id, { status: 'error', error: describeUploadError(error) });
      })
      .finally(() => {
        if (current.current?.handle === handle) {
          current.current = null;
        }
      });
  }, [busy, nextId, stageId, patch]);

  // Уход со страницы этапа — прерываем отправку, чтобы не оставлять фоновых запросов.
  useEffect(() => () => current.current?.handle.abort(), []);

  const add = useCallback((files: Iterable<File>): void => {
    const added: IUploadEntry[] = [];
    for (const file of files) {
      const id = newUuid();
      sources.current.set(id, { file, key: newUuid() });
      added.push({ id, name: file.name, size: file.size, status: 'queued', progress: 0, error: null, batch: null });
    }
    if (added.length > 0) {
      setEntries((list) => [...list, ...added]);
    }
  }, []);

  const retry = useCallback((id: string): void => patch(id, { status: 'queued', progress: 0, error: null }), [patch]);

  const cancel = useCallback(
    (id: string): void => {
      if (current.current?.id === id) {
        current.current.handle.abort();
        current.current = null;
      }
      patch(id, { status: 'error', error: 'Отправка отменена.' });
    },
    [patch],
  );

  const remove = useCallback((id: string): void => {
    if (current.current?.id === id) {
      return;
    }
    sources.current.delete(id);
    setEntries((list) => list.filter((entry) => entry.id !== id));
  }, []);

  const clearFinished = useCallback((): void => {
    setEntries((list) => {
      const keep = list.filter((entry) => entry.status !== 'accepted');
      for (const entry of list) {
        if (entry.status === 'accepted') {
          sources.current.delete(entry.id);
        }
      }
      return keep;
    });
  }, []);

  return { entries, add, retry, cancel, remove, clearFinished };
};
