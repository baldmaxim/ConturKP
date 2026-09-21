import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Файлы тестов делят один кластер PostgreSQL и диск: без ограничения параллелизма
    // тяжёлые сценарии (большой архив, копирование крупных файлов) мешают друг другу.
    maxWorkers: 4,
  },
});
