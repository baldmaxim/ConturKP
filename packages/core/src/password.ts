// Хэширование паролей argon2id (ADR-006 §11) встроенным node:crypto (Node.js ≥ 24.7).
// Формат хранения — PHC-строка с параметрами, поэтому параметры и реализацию можно
// сменить без миграции: старые хэши проверяются по своим параметрам. Соль и ключ — base64
// стандартного алфавита без «=», как у эталонной реализации и пакета argon2 (R02-04).
// Хэши первой версии этапа 02 (base64url) читаются и переписываются при входе (needsRehash).
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

interface IArgonParams {
  memory: number;
  passes: number;
  parallelism: number;
}

// Параметры OWASP Password Storage Cheat Sheet для argon2id: m = 19 МиБ, t = 2, p = 1.
const DEFAULT_PARAMS: IArgonParams = { memory: 19456, passes: 2, parallelism: 1 };
const TAG_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 12;

const derive = (password: string, salt: Buffer, params: IArgonParams, tagLength = TAG_LENGTH): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, tagLength, ...params },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await derive(password, salt, DEFAULT_PARAMS);
  const p = DEFAULT_PARAMS;
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(key)}`;
};

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

interface IParsedHash {
  params: IArgonParams;
  salt: Buffer;
  key: Buffer;
  urlAlphabet: boolean;
}

// PHC: $argon2id$v=19$<параметры через запятую в любом порядке>$<соль>$<ключ>.
// Порядок параметров у реализаций разный (портал пишет m,t,p; пакет argon2 — m,p,t).
// Декодер Node 'base64' принимает оба алфавита (стандартный и URL-safe).
const PHC = /^\$argon2id\$v=19\$([a-z]=\d+(?:,[a-z]=\d+)*)\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/;

const parseHash = (stored: string): IParsedHash | null => {
  const m = PHC.exec(stored);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const values = new Map(m[1].split(',').map((kv) => [kv[0] ?? '', Number(kv.slice(2))] as const));
  const memory = values.get('m');
  const passes = values.get('t');
  const parallelism = values.get('p');
  if (values.size !== 3 || !memory || !passes || !parallelism) return null;
  return {
    params: { memory, passes, parallelism },
    salt: Buffer.from(m[2], 'base64'),
    key: Buffer.from(m[3], 'base64'),
    urlAlphabet: /[-_]/.test(`${m[2]}${m[3]}`),
  };
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const h = parseHash(stored);
  if (!h) return false;
  const actual = await derive(password, h.salt, h.params, h.key.length);
  return actual.length === h.key.length && timingSafeEqual(actual, h.key);
};

// Хэш не в текущем формате или с прежними параметрами — переписать после успешного входа.
export const needsRehash = (stored: string): boolean => {
  const h = parseHash(stored);
  if (!h) return true;
  const p = DEFAULT_PARAMS;
  return h.urlAlphabet || h.key.length !== TAG_LENGTH || h.params.memory !== p.memory || h.params.passes !== p.passes || h.params.parallelism !== p.parallelism;
};

// Для неизвестного логина выполняем ту же работу, чтобы время ответа не выдавало,
// существует ли пользователь.
let dummyHash: Promise<string> | null = null;
export const burnPasswordCheck = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword('kontur-dummy-password');
  await verifyPassword(password, await dummyHash);
};

export const passwordProblem = (password: string): string | null =>
  password.length < MIN_PASSWORD_LENGTH ? `пароль не короче ${MIN_PASSWORD_LENGTH} символов` : null;
