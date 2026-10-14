-- Этап 17 (ADR-011 §7–11): копия снимается и восстанавливается.
--
-- 1. Права роли копии (S17-01). pg_dump выполняется ролью kontur_backup, но SELECT ей давали только миграции 0001,
--    0002, 0005, 0009, 0011, 0012, 0017, 0019: 85 из 174 таблиц и последовательности identity были ей недоступны,
--    и копия не снималась. Роль только читает: прав записи, создания объектов и SECURITY DEFINER у неё нет (сторож —
--    tests/backupGrants.test.ts). Права по умолчанию закрывают тот же пробел для будущих миграций.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kontur_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO kontur_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE kontur_migrator IN SCHEMA public GRANT SELECT ON TABLES TO kontur_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE kontur_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO kontur_backup;

-- 2. Восстановимость дампа (S17-20, найдено сквозным тестом A40). pg_restore выполняет загрузку с пустым search_path,
--    а функции из ограничений CHECK и вычисляемых столбцов вызывают другие функции схемы без её имени: COPY таблицы
--    evidence_fragment падал на evidence_locator_valid → jsonb_positive_int. Функциям, на которые прямо ссылаются
--    ограничения, индексы и вычисляемые столбцы, фиксируется search_path — он действует и на вложенные вызовы.
--    Результаты функций не меняются: pg_catalog и так просматривается первым, public — схема всех объектов портала.
ALTER FUNCTION search_prepare(text) SET search_path = pg_catalog, public;
ALTER FUNCTION local_recognizer_valid(jsonb) SET search_path = pg_catalog, public;
ALTER FUNCTION evidence_locator_valid(jsonb) SET search_path = pg_catalog, public;
