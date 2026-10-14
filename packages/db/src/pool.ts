import pg from 'pg';

// int8 (count, row_version, seq) → number с проверкой безопасного диапазона.
// numeric (деньги) не трогаем: остаётся строкой (ADR-005).
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 вне безопасного диапазона: ${value}`);
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// Обрыв соединения (перезапуск PostgreSQL, сеть) не должен ронять процесс (этап 17, S17-02): ошибку
// простаивающего клиента pg-pool отдаёт событием пула, а у выданного клиента собственного слушателя нет —
// pg шлёт `error` на клиенте. Запрос и так завершается отказом, а клиент с ошибкой выбрасывается при release.
export const createPool = (connectionString: string, max = 10, onError?: (message: string) => void): pg.Pool => {
  const pool = new pg.Pool({ connectionString, max, application_name: 'kontur-kp', keepAlive: true });
  const report = (err: Error): void => onError?.(`соединение с БД: ${err.message}`);
  pool.on('error', report);
  pool.on('connect', (client) => {
    client.on('error', report);
  });
  return pool;
};

export const withTransaction = async <T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

// Пул отличается от клиента наличием счётчиков соединений: это позволяет одной и той же
// операции работать и самостоятельной короткой транзакцией (дан пул), и внутри уже открытой
// транзакции вызывающего (дан клиент).
export const isPoolLike = (db: Queryable): boolean => typeof (db as unknown as { totalCount?: unknown }).totalCount === 'number';

export const inTransaction = async <T>(db: Queryable, fn: (client: Queryable) => Promise<T>): Promise<T> =>
  isPoolLike(db) ? withTransaction(db as unknown as pg.Pool, (client) => fn(client)) : fn(db);

export const databaseNameOf = (connectionString: string): string =>
  decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
