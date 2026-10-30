-- Счётчики текущей попытки; очищаются при каждом захвате и пишутся под арендой.
ALTER TABLE job ADD COLUMN progress jsonb;
ALTER TABLE job ADD CONSTRAINT job_progress_object CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object');
