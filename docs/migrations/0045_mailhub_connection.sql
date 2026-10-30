-- Автоматическое чтение MailHub. Один внешний логический item — одно письмо в общей выданной области.
-- Копии в пяти ящиках — метаданные происхождения, не пять импортов и комплектов вложений.
CREATE TABLE mailhub_connection (
  source_key text PRIMARY KEY,
  mailbox_id uuid NOT NULL REFERENCES mailbox(id),
  actor_user_id uuid NOT NULL REFERENCES app_user(id),
  allowed_mailboxes uuid[] NOT NULL CHECK (cardinality(allowed_mailboxes)>0),
  cursor text,
  since_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  full_scan_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_change_at timestamptz,
  last_error_code text,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE mailhub_message (
  source_key text NOT NULL REFERENCES mailhub_connection(source_key),
  external_id uuid NOT NULL,
  source_changed_at timestamptz NOT NULL,
  copies jsonb NOT NULL CHECK (jsonb_typeof(copies) = 'array'),
  import_id uuid UNIQUE REFERENCES mail_import(id),
  failure_code text,
  retry_after timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key,external_id)
);
CREATE INDEX mailhub_message_pending ON mailhub_message(source_key,retry_after,source_changed_at DESC) WHERE import_id IS NULL;
GRANT SELECT,INSERT,UPDATE ON mailhub_connection,mailhub_message TO kontur_app;
GRANT SELECT ON mailhub_connection,mailhub_message TO kontur_backup;
CREATE FUNCTION guard_mailhub_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.source_key<>OLD.source_key OR NEW.external_id<>OLD.external_id
    OR (OLD.import_id IS NOT NULL AND NEW.import_id IS DISTINCT FROM OLD.import_id)) THEN
    RAISE EXCEPTION 'MailHub identity and assigned import are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.import_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM mail_import i JOIN mailhub_connection c ON c.mailbox_id=i.mailbox_id
    WHERE c.source_key=NEW.source_key AND i.id=NEW.import_id
  ) THEN RAISE EXCEPTION 'MailHub import belongs to another scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_mailhub_message_identity BEFORE INSERT OR UPDATE ON mailhub_message
FOR EACH ROW EXECUTE FUNCTION guard_mailhub_message_identity();
