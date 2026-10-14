// Самоподписанный сертификат для тестов TLS (этап 17, проект §10): собирается средствами node:crypto (DER, ECDSA
// P-256) — без openssl (на Windows ревьюера его обычно нет в PATH) и без закрытого ключа в Git. Ключ живёт только
// во временном каталоге теста.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const int = (b: Buffer): Buffer => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, 'hex'));
const utc = (d: Date): Buffer => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/gu, '').slice(2, 14)}Z`));
const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/gu, '$1\n').replace(/\n$/u, '')}\n-----END ${label}-----\n`;

const ECDSA_SHA256 = '2a8648ce3d040302';
const COMMON_NAME = '550403';
const SUBJECT_ALT_NAME = '551d11';

export interface ITestCert {
  certPem: string;
  keyPem: string;
}

export const selfSignedCert = (o: { cn?: string; dns?: string[]; ips?: string[]; days?: number; notBefore?: Date } = {}): ITestCert => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const notBefore = o.notBefore ?? new Date(Date.now() - 3600_000);
  const notAfter = new Date(notBefore.getTime() + (o.days ?? 30) * 86_400_000);
  const alg = seq(oid(ECDSA_SHA256));
  const name = seq(set(seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(o.cn ?? 'kontur-test')))));
  const names = [
    ...(o.dns ?? ['localhost']).map((d) => tlv(0x82, Buffer.from(d))),
    ...(o.ips ?? ['127.0.0.1']).map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  const san = seq(oid(SUBJECT_ALT_NAME), tlv(0x04, seq(...names)));
  const serial = randomBytes(8);
  serial[0] = serial[0]! & 0x7f;
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    alg,
    name,
    seq(utc(notBefore), utc(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(san)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), signature));
  return { certPem: pem('CERTIFICATE', der), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
