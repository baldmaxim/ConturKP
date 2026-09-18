// Хэширование паролей argon2id (ADR-006 §11) встроенным node:crypto (Node.js ≥ 24.7).
// Формат хранения — PHC-строка с параметрами, поэтому параметры и реализацию можно
// сменить без миграции: старые хэши проверяются по своим параметрам.
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

const derive = (password: string, salt: Buffer, params: IArgonParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, tagLength: TAG_LENGTH, ...params },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await derive(password, salt, DEFAULT_PARAMS);
  const p = DEFAULT_PARAMS;
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${salt.toString('base64url')}$${key.toString('base64url')}`;
};

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const m = PHC.exec(stored);
  if (!m) return false;
  const params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  const salt = Buffer.from(m[4] ?? '', 'base64url');
  const expected = Buffer.from(m[5] ?? '', 'base64url');
  const actual = await derive(password, salt, params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
