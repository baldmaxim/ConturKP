-- Shared materials are independent sources, never pseudo tenders or automatic inputs to a stage.
ALTER TABLE tender_history_binding ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE tender_history_task ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE tender_history_watch ADD COLUMN directory_paths jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tender_history_watch ADD COLUMN directory_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE tender_history_watch ADD CONSTRAINT history_directory_paths_array CHECK(jsonb_typeof(directory_paths)='array');
CREATE FUNCTION history_actor_can_write(actor uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN target IS NULL THEN EXISTS(SELECT 1 FROM app_user u JOIN user_role r ON r.user_id=u.id
   WHERE u.id=actor AND u.status='active' AND r.role IN('manager','engineer'))
 ELSE 'source.write'=ANY(tender_capabilities(actor,target)) END
$$;
CREATE FUNCTION history_actor_can_manage(actor uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT history_actor_can_write(actor,target) AND (EXISTS(SELECT 1 FROM user_role WHERE user_id=actor AND role='admin')
  OR(target IS NOT NULL AND 'hold.resolve'=ANY(tender_capabilities(actor,target))))
$$;
CREATE OR REPLACE FUNCTION tender_history_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; target uuid;
BEGIN
 IF TG_TABLE_NAME='tender_history_binding' THEN actor:=NEW.created_by; target:=NEW.tender_id;
 ELSE actor:=NEW.imported_by; SELECT tender_id INTO target FROM tender_history_binding WHERE id=NEW.binding_id; END IF;
 IF NOT history_actor_can_manage(actor,target) THEN RAISE EXCEPTION 'history import authorization' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION tender_history_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tender_history_record r JOIN tender_history_binding b ON b.id=r.binding_id
   WHERE r.id=NEW.record_id AND b.tender_id IS NOT DISTINCT FROM NEW.tender_id AND NOT r.restricted)
 THEN RAISE EXCEPTION 'history record scope' USING ERRCODE='23514'; END IF;
 IF NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tender_history_file f JOIN tender_history_binding b ON b.id=f.binding_id
   WHERE f.id=NEW.file_id AND b.tender_id IS NOT DISTINCT FROM NEW.tender_id)
 THEN RAISE EXCEPTION 'history file scope' USING ERRCODE='23514'; END IF;
 IF NEW.owner_user_id IS NOT NULL AND NOT history_actor_can_write(NEW.owner_user_id,NEW.tender_id)
 THEN RAISE EXCEPTION 'history owner is not an active member' USING ERRCODE='23514'; END IF;
 IF NOT history_actor_can_write(NEW.updated_by,NEW.tender_id) THEN RAISE EXCEPTION 'history task write denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND(NEW.tender_id,NEW.record_id,NEW.file_id,NEW.created_by) IS DISTINCT FROM(OLD.tender_id,OLD.record_id,OLD.file_id,OLD.created_by)
 THEN RAISE EXCEPTION 'history task identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND(NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.row_version<>OLD.row_version+1)
 THEN RAISE EXCEPTION 'history task version or identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
