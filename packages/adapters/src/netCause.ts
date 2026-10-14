// Причина сетевого отказа для пользователя и журнала (этап 17, проект §7.1, спецификация §12 «источник ошибки виден»):
// Встроенный HTTP-клиент Node (undici) кладёт код ОС в err.cause.code. Адресов, ключей и тел здесь нет — только класс причины и код.
export type NetworkCause = 'dns' | 'refused' | 'timeout' | 'reset' | 'tls' | 'network';

const TLS_RE = /^(CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_TLS_|ERR_SSL_)/u;

export const networkCodeOf = (err: unknown): string | null => {
  const e = err as { code?: unknown; cause?: { code?: unknown; cause?: { code?: unknown } } } | null;
  const code = e?.cause?.code ?? e?.cause?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : null;
};

export const networkCause = (err: unknown): NetworkCause => {
  const code = networkCodeOf(err) ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NONAME') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'reset';
  if (TLS_RE.test(code)) return 'tls';
  return 'network';
};

const TEXT: Record<NetworkCause, string> = {
  dns: 'имя сервера не разрешается (DNS)',
  refused: 'соединение отклонено: сервер не слушает порт',
  timeout: 'соединение не установлено за отведённое время',
  reset: 'соединение оборвано',
  tls: 'сертификат сервера не принят (TLS)',
  network: 'сетевая ошибка',
};

// «имя сервера не разрешается (DNS, ENOTFOUND)» — текст для сообщения об отказе.
export const describeNetworkError = (err: unknown): string => {
  const code = networkCodeOf(err);
  return `${TEXT[networkCause(err)]}${code ? `, ${code}` : ''}`;
};

// Тело ответа с пределом: большой ответ не читается в память целиком (этап 17, проект §7.2). null — предел превышен.
export const readTextLimited = async (res: Response, maxBytes: number): Promise<string | null> => {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

// Граница всей операции запроса — от отправки до конца чтения и разбора тела (R17-01): тайм-аут и внешняя отмена
// действуют, пока тело не прочитано; снимаются в dispose() из finally всей операции. timedOut() отличает
// истечение тайм-аута от отмены вызывающим (остановка worker, отмена поиска).
export interface IOperationGuard {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancelled: () => boolean;
  dispose: () => void;
}

export const operationGuard = (timeoutMs: number, external?: AbortSignal): IOperationGuard => {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    cancelled: () => !expired && Boolean(external?.aborted),
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
};
