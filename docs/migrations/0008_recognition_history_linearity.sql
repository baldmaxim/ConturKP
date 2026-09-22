-- 0008 — линейность истории распознавания на уровне БД (ревью 04-3: R04-12).
--
-- Дисциплины API мало: роль kontur_app имеет прямой INSERT в recognition_run, а охранник
-- миграции 0005 проверял только «предшественник завершён и той же редакции». После
-- цепочки A → B оставалось возможным вставить C → A (второе ответвление) и вставить новый
-- прогон с supersedes_run_id = NULL при уже существующей успешной истории (второй корень).
-- Частичный индекс «один незавершённый прогон» этому не мешает: активного прогона в момент
-- вставки нет.

-- ---------------------------------------------------------------- один потомок у предка

-- Предшественник может быть перекрыт ровно один раз: иначе история ветвится (A10, I15).
-- Отказавшая и отменённая попытка место потомка не занимает — иначе один сбой закрывал бы
-- редакцию навсегда: новый прогон не смог бы ни встать за хвостом, ни начать историю заново.
-- Предикат тот же, что у recognition_run_artifact_key (0006).
CREATE UNIQUE INDEX recognition_run_supersedes_key
  ON recognition_run (supersedes_run_id)
  WHERE supersedes_run_id IS NOT NULL AND status NOT IN ('failed', 'cancelled');

-- ---------------------------------------------------------------- корень и хвост цепочки

-- Тот же охранник, что в 0005, плюс: корень истории редакции только один, а новый прогон
-- встаёт за текущим хвостом. Вставки по одной редакции сериализуются тем же ключом
-- advisory-блокировки, что берёт приём архива в API (packages/db/src/recognition.ts):
-- проверка «хвост свободен» не должна разъезжаться со вставкой.
CREATE OR REPLACE FUNCTION recognition_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recognition_import'), hashtext(NEW.document_revision_id::text));
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'recognition_run: прогон создаётся в состоянии queued' USING ERRCODE = '55000';
  END IF;
  IF NEW.supersedes_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run p
        WHERE p.id = NEW.supersedes_run_id
          AND p.document_revision_id = NEW.document_revision_id
          AND p.status IN ('complete', 'partial')
     ) THEN
    RAISE EXCEPTION 'recognition_run: предшественник — завершённый прогон той же редакции' USING ERRCODE = '23514';
  END IF;
  -- Второй корень истории. Успешная история у редакции уже есть — новый прогон обязан
  -- встать за ней, а не начать параллельную ветку с нуля.
  IF NEW.supersedes_run_id IS NULL AND EXISTS (
       SELECT 1 FROM recognition_run p
        WHERE p.document_revision_id = NEW.document_revision_id
          AND p.status IN ('complete', 'partial')
     ) THEN
    RAISE EXCEPTION 'recognition_run: у редакции уже есть история распознавания — новый прогон встаёт за её хвостом (A10)'
      USING ERRCODE = '23514';
  END IF;
  -- Предшественник — именно хвост: перекрывать середину цепочки нельзя. Отказавшие и
  -- отменённые потомки хвостом не считаются, попытку можно повторить.
  IF NEW.supersedes_run_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM recognition_run c
        WHERE c.supersedes_run_id = NEW.supersedes_run_id AND c.status NOT IN ('failed', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'recognition_run: предшественник уже перекрыт — новый прогон встаёт за хвостом истории (A10)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
