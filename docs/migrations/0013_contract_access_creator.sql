-- 0013 — R06a-01 (Review 06a-1): полный инвариант выдачи создателя договора в contract_access.
-- Миграция 0012 проверяла строку source = creator внешним ключом (creator_contract_id, user_id) →
-- contract (id, created_by). У глобальной contract.create договора нет (contract_id NULL), генерируемая
-- creator_contract_id тоже NULL, и обычный FK такую строку не проверяет: прямой вставкой можно было записать
-- «право создателя» contract.create без единого созданного договора. Схема не запрещала и creator-выдачу
-- contract.link, хотя создатель получает только чтение и ведение (интерпретация 1, подтверждена Review 06a-1).
-- Теперь строка создателя — только по конкретному договору и только contract.read или contract.manage;
-- прежний FK на автора договора остаётся. Глобальная contract.create возможна лишь с source = admin.
ALTER TABLE contract_access
  ADD CONSTRAINT contract_access_creator_capability_shape
    CHECK (source <> 'creator' OR (contract_id IS NOT NULL AND capability IN ('contract.read', 'contract.manage')));
