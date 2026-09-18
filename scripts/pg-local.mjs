// Локальный изолированный кластер PostgreSQL для разработки и тестов.
// Данные — в runtime/pg (вне Git), слушает только 127.0.0.1.
// Аутентификация trust допустима только потому, что кластер локальный и одноразовый;
// в production используется отдельный кластер с паролями (ADR-011).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = resolve(ROOT, 'runtime', 'pg');
const LOG_FILE = resolve(ROOT, 'runtime', 'pg.log');
const PORT = process.env.KONTUR_PG_PORT ?? '55432';

// На Windows postgres наследует дескрипторы pg_ctl: при stdio 'inherit' вызов start не завершается.
const run = (cmd, args, detached = false) => {
  const r = spawnSync(cmd, args, { stdio: detached ? 'ignore' : 'inherit' });
  return r.status ?? 1;
};

const init = () => {
  if (existsSync(resolve(DATA_DIR, 'PG_VERSION'))) {
    console.log(`Кластер уже создан: ${DATA_DIR}`);
    return 0;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const code = run('initdb', ['-D', DATA_DIR, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  if (code !== 0) return code;
  appendFileSync(
    resolve(DATA_DIR, 'postgresql.conf'),
    `\nlisten_addresses = '127.0.0.1'\nport = ${PORT}\ntimezone = 'UTC'\n`,
  );
  writeFileSync(
    resolve(DATA_DIR, 'pg_hba.conf'),
    'local all all trust\nhost all all 127.0.0.1/32 trust\n',
  );
  console.log(`Кластер создан: ${DATA_DIR}, порт ${PORT}`);
  return 0;
};

const commands = {
  init,
  start: () => {
    const code = run('pg_ctl', ['-D', DATA_DIR, '-l', LOG_FILE, '-w', 'start'], true);
    console.log(code === 0 ? `PostgreSQL запущен на 127.0.0.1:${PORT}` : `Ошибка запуска, см. ${LOG_FILE}`);
    return code;
  },
  stop: () => run('pg_ctl', ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop']),
  status: () => run('pg_ctl', ['-D', DATA_DIR, 'status']),
};

const cmd = process.argv[2];
if (!cmd || !(cmd in commands)) {
  console.error('Использование: node scripts/pg-local.mjs init|start|stop|status');
  process.exit(2);
}
process.exit(commands[cmd]());
