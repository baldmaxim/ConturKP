// Загрузка файла телом запроса (application/octet-stream), имя — параметр name.
// XMLHttpRequest вместо fetch ради прогресса отправки (fetch не сообщает о ходе upload).
// Один путь для источников этапа и для экспорта распознавания: различаются только адрес
// и тип ответа.
import { API_BASE, ApiError, csrfToken, isProblem, notifyUnauthenticated } from './client';
import type { IImportBatch, IProblem, IRecognitionRunAccepted } from './types';

export interface IUploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

const problemOf = (xhr: XMLHttpRequest): IProblem => {
  const contentType = xhr.getResponseHeader('content-type') ?? '';
  if (contentType.includes('json') && xhr.responseText) {
    try {
      const body: unknown = JSON.parse(xhr.responseText);
      if (isProblem(body)) {
        return body;
      }
    } catch {
      // Тело не разобрано — ниже собираем problem по статусу.
    }
  }
  return {
    type: 'about:blank',
    title: xhr.statusText || 'Ошибка',
    status: xhr.status,
    code: xhr.status >= 500 ? 'INTERNAL' : 'UNKNOWN',
    requestId: xhr.getResponseHeader('x-request-id') ?? '',
  };
};

const xhrUpload = <T>(url: string, file: File, idempotencyKey: string, onProgress: (fraction: number) => void): IUploadHandle<T> => {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
    const csrf = csrfToken();
    if (csrf) {
      xhr.setRequestHeader('X-CSRF-Token', csrf);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError('Ответ сервера не разобран', xhr.status, null));
        }
        return;
      }
      const problem = problemOf(xhr);
      if (xhr.status === 401) {
        notifyUnauthenticated();
      }
      reject(new ApiError(problem.title, xhr.status, problem));
    };
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером', 0, null, true));
    xhr.onabort = () => reject(new DOMException('Загрузка отменена', 'AbortError'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
};

/**
 * Отправляет файл в этап. idempotencyKey — один на файл: повтор после сетевой ошибки идёт с тем же ключом,
 * и сервер не создаст вторую партию. onProgress получает долю отправленного (0…1).
 */
export const uploadImport = (
  stageId: string,
  file: File,
  idempotencyKey: string,
  onProgress: (fraction: number) => void,
): IUploadHandle<IImportBatch> =>
  xhrUpload<IImportBatch>(
    `${API_BASE}/stages/${encodeURIComponent(stageId)}/imports?name=${encodeURIComponent(file.name)}`,
    file,
    idempotencyKey,
    onProgress,
  );

/**
 * Отправляет экспортный архив RDWeb к зарегистрированной редакции. Соответствие PDF
 * проверяет сервер по SHA-256: чужой или старый результат отклоняется прогоном.
 */
export const uploadRecognitionExport = (
  revisionId: string,
  file: File,
  idempotencyKey: string,
  onProgress: (fraction: number) => void,
): IUploadHandle<IRecognitionRunAccepted> =>
  xhrUpload<IRecognitionRunAccepted>(
    `${API_BASE}/document-revisions/${encodeURIComponent(revisionId)}/recognition-imports?name=${encodeURIComponent(file.name)}`,
    file,
    idempotencyKey,
    onProgress,
  );
