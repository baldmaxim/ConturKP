// npm run ops:integration-verify -- --system <система> --component <компонент> --journal <журнал> --admin <логин> [--create]
// Запись живой проверки интеграции в базу установки (VERIFIED_LIVE, этап 17): журнал — режим LIVE, коммит установленной
// сборки (KONTUR_BUILD), «Итог: PASS». Пример: --system tenderhub --component TenderHubReader --journal live-smoke.log.
// Код выхода: 0 — записано, 1 — отказ (причина), 2 — неверный запуск.
import { buildId } from '../../packages/config/src/index.ts';
import { createPool } from '../../packages/db/src/index.ts';
import { argValue, hasFlag } from '../cli.ts';
import { recordLiveCheck, VerifyError } from './integration-verify-lib.ts';

const main = async (): Promise<number> => {
  const system = argValue('system');
  const component = argValue('component');
  const journal = argValue('journal');
  const admin = argValue('admin');
  if (!system || !component || !journal || !admin || !process.env.DATABASE_URL) {
    console.error('нужны --system, --component, --journal, --admin и DATABASE_URL');
    return 2;
  }
  const pool = createPool(process.env.DATABASE_URL, 2);
  try {
    const r = await recordLiveCheck(pool, { system, component, journal, adminLogin: admin, build: buildId(), create: hasFlag('create') });
    console.log(`${system}/${component}: VERIFIED_LIVE, основание ${r.evidenceRef}`);
    return 0;
  } catch (err) {
    console.error(err instanceof VerifyError ? `не записано: ${err.message}` : `не записано: ${err instanceof Error ? err.message : 'ошибка'}`);
    return 1;
  } finally {
    await pool.end();
  }
};

void main().then((code) => {
  process.exitCode = code;
});
