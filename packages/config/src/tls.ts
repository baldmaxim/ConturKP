// Проверка TLS установки для config:check (этап 17, проект §10, U-02): файлы читаются, пара сертификат–ключ
// совпадает, адреса из ALLOWED_ORIGINS входят в сертификат, срок действия. Содержимое ключа не выводится.
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { ITlsConfig } from './index.ts';

export interface ITlsFacts {
  problems: string[];
  warnings: string[];
  subjectAltNames: string[];
  validTo: string | null;
  daysLeft: number | null;
}

export const inspectTls = (tls: ITlsConfig, origins: readonly string[], now: Date = new Date(), read: (p: string) => Buffer = readFileSync): ITlsFacts => {
  const facts: ITlsFacts = { problems: [], warnings: [], subjectAltNames: [], validTo: null, daysLeft: null };
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(read(tls.certFile));
  } catch (err) {
    facts.problems.push(`TLS_CERT_FILE не читается как сертификат PEM: ${(err as NodeJS.ErrnoException).code ?? 'неверный формат'}`);
    return facts;
  }
  facts.subjectAltNames = (cert.subjectAltName ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  facts.validTo = new Date(cert.validTo).toISOString();
  facts.daysLeft = Math.floor((new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000);
  if (facts.daysLeft < 0) facts.problems.push(`сертификат истёк ${facts.validTo}`);
  else if (facts.daysLeft < 30) facts.warnings.push(`сертификат истекает через ${facts.daysLeft} дн. — выпустите новый (mkcert)`);
  if (new Date(cert.validFrom).getTime() > now.getTime()) facts.problems.push('сертификат ещё не действует (проверьте часы ПК)');
  try {
    const key = createPrivateKey(read(tls.keyFile));
    if (!cert.checkPrivateKey(key)) facts.problems.push('TLS_KEY_FILE не соответствует сертификату TLS_CERT_FILE');
  } catch (err) {
    facts.problems.push(`TLS_KEY_FILE не читается как закрытый ключ PEM: ${(err as NodeJS.ErrnoException).code ?? 'неверный формат или пароль'}`);
  }
  for (const origin of origins) {
    let host: string;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:') continue;
      host = u.hostname.replace(/^\[|\]$/gu, '');
    } catch {
      continue;
    }
    const covered = isIP(host) ? cert.checkIP(host) !== undefined : cert.checkHost(host) !== undefined;
    if (!covered) facts.problems.push(`адрес ${host} из ALLOWED_ORIGINS не входит в сертификат (${facts.subjectAltNames.join(', ') || 'нет SAN'})`);
  }
  return facts;
};
