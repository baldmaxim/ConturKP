-- Отдельно храним размещение и итог участия. Существующий архив выигран по указанию владельца.
ALTER TABLE tender ADD COLUMN outcome text;
UPDATE tender SET outcome = 'won', row_version = row_version + 1, updated_at = now() WHERE status = 'archived';
ALTER TABLE tender ADD CONSTRAINT tender_status_outcome_check CHECK (
  (status = 'active' AND outcome IS NULL) OR
  (status = 'archived' AND outcome IS NOT NULL AND outcome IN ('won', 'lost'))
);
