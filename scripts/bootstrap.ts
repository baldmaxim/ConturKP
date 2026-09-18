// npm run bootstrap -- --login <логин> --name "<Имя>" [--roles admin,manager] [--password-stdin]
// Создаёт первого администратора (по умолчанию он же руководитель). Пароль вводится скрыто.
import { LOGIN, ROLE } from '../packages/contracts/src/index.ts';
import { createPool } from '../packages/db/src/index.ts';
import { bootstrapOwner, BootstrapRefused } from '../apps/server/src/bootstrap.ts';
import { argValue, fail, readPassword } from './cli.ts';

const url = process.env.DATABASE_URL;
if (!url) fail('нужен DATABASE_URL', 2);
const login = LOGIN.safeParse(argValue('login') ?? '');
const displayName = argValue('name')?.trim();
const roles = (argValue('roles') ?? 'admin,manager').split(',').map((r) => ROLE.safeParse(r.trim()));
if (!login.success || !displayName || roles.some((r) => !r.success)) {
  fail('использование: npm run bootstrap -- --login <логин> --name "<Имя>" [--roles admin,manager] [--password-stdin]', 2);
}
const password = await readPassword('Пароль (не короче 12 символов)');
const pool = createPool(url!, 1);
try {
  const id = await bootstrapOwner(pool, {
    login: login.data!,
    displayName: displayName!,
    password,
    roles: roles.map((r) => r.data!),
  });
  console.log(`создан пользователь ${login.data} (${id}), роли: ${roles.map((r) => r.data).join(', ')}`);
} catch (err) {
  if (err instanceof BootstrapRefused) fail(`отказ: ${err.message}`, 4);
  throw err;
} finally {
  await pool.end();
}
