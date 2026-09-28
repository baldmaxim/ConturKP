// Индекс поиска портала (ADR-012 §5, state-machines §20): состояние версий и постановка пересборки.
// status  — версии, полнота активной и строящейся, состояние модели эмбеддингов;
// rebuild — новая строящаяся версия; worker строит её рядом с активной и активирует после полноты.
// Подключение — DATABASE_URL (роль приложения). Значения секретов не выводятся.
import { CHUNKER_VERSION } from '../packages/core/src/index.ts';
import { createPool, createVersion, getModelStatus, listVersions, versionCompleteness, versionVectorCounts } from '../packages/db/src/index.ts';
import { fail } from './cli.ts';

const url = process.env.DATABASE_URL;
if (!url) fail('нужен DATABASE_URL', 2);
const pool = createPool(url!, 2);
const cmd = process.argv[2] ?? 'status';
try {
  if (cmd === 'status') {
    const versions = await listVersions(pool);
    if (versions.length === 0) console.log('версий индекса нет: первую создаёт worker при запуске');
    for (const v of versions) {
      const counts = await versionVectorCounts(pool, v.id);
      const live = v.status === 'active' || v.status === 'building';
      const c = live ? await versionCompleteness(pool, v) : null;
      console.log(
        [
          `версия ${v.seq}: ${v.status}`,
          v.embedding_model ? `модель ${v.embedding_model}, размерность ${v.embedding_dim}` : 'без векторов',
          `чанков ${counts.chunks}, векторов ${counts.vectors}`,
          c ? `не проиндексировано единиц ${c.missingUnits}, чанков без векторов ${c.missingVectors}` : null,
          v.purged_at ? 'данные удалены' : null,
          v.failure_code ? `отказ ${v.failure_code}` : null,
        ]
          .filter(Boolean)
          .join('; '),
      );
    }
    const model = await getModelStatus(pool);
    console.log(
      model
        ? `модель эмбеддингов: ${model.status}; последняя проверка ${model.last_checked_at?.toISOString() ?? '—'}; ${model.last_error_code ? `отказ ${model.last_error_code}` : 'доступна'}`
        : 'модель эмбеддингов: состояние ещё не записано worker',
    );
  } else if (cmd === 'rebuild') {
    const id = await createVersion(pool, { chunkerVersion: CHUNKER_VERSION, embedding: null, createdBy: null }).catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505') fail('строящаяся версия уже есть: дождитесь её активации (search-index status)', 4);
      throw err;
    });
    console.log(`создана строящаяся версия ${id}; worker построит её и активирует после полноты`);
    console.log('версию с моделью эмбеддингов worker создаёт сам, когда модель настроена и отвечает');
  } else {
    fail('использование: search-index status | rebuild', 2);
  }
} finally {
  await pool.end();
}
