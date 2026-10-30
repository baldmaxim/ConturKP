-- Каталог собственных ролей, настраиваемые разрешения и отдельный доступ к офису.
CREATE TABLE portal_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=500),
  base_role text NOT NULL CHECK (base_role IN ('engineer','manager','admin')),
  permissions text[] NOT NULL CHECK (permissions <@ ARRAY['office.read','templates.read','tender.read.all','contract.read.all','mail.read.all','tender.read','stage.write','stage.manage','source.write','calculation.capture','audit.read','hold.resolve','requirement.read','requirement.create','requirement.confirm','requirement.decide','requirement.manage','analysis.run','fact.read','fact.create','fact.confirm','review.run','finding.write','finding.accept_risk','source_priority.manage','economics.compare','change_reason.confirm','application.fill','template.manage','candidate.create','candidate.approve','risk.accept','calculation.close','candidate.release','delivery.manage','send.register','send.accept_extras','mcp.propose','contract.create','contract.read','contract.link','contract.manage','mail.read','mail.import','mail.link','mail.manage','admin.templates','wording.propose','wording.approve','admin.users','admin.roles','admin.tender','admin.contract','admin.mailbox','admin.intake','admin.delivery','admin.audit','history.read','history.write','history.manage']::text[]),
  built_in boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX portal_role_name_key ON portal_role(lower(trim(name)));
GRANT SELECT, INSERT, UPDATE ON portal_role TO kontur_app;
GRANT SELECT ON portal_role TO kontur_backup;
INSERT INTO portal_role(id,code,name,base_role,permissions,built_in) VALUES('00000000-0000-4000-8000-000000000001','engineer','Инженер','engineer',ARRAY['templates.read','history.read','history.write','tender.read','stage.write','source.write','calculation.capture','requirement.read','requirement.create','analysis.run','fact.read','fact.create','review.run','finding.write','economics.compare','change_reason.confirm','application.fill','candidate.create','delivery.manage','mcp.propose','candidate.release','send.register','contract.read','contract.link','contract.manage','mail.read','mail.import','mail.link','mail.manage','contract.create','wording.propose']::text[],true);
INSERT INTO portal_role(id,code,name,base_role,permissions,built_in) VALUES('00000000-0000-4000-8000-000000000002','manager','Руководитель','manager',ARRAY['admin.templates','wording.approve','office.read','templates.read','tender.read.all','contract.read.all','mail.read.all','history.read','history.write','tender.read','stage.write','source.write','calculation.capture','requirement.read','requirement.create','analysis.run','fact.read','fact.create','review.run','finding.write','economics.compare','change_reason.confirm','application.fill','candidate.create','delivery.manage','mcp.propose','stage.manage','hold.resolve','requirement.confirm','requirement.decide','requirement.manage','fact.confirm','finding.accept_risk','source_priority.manage','template.manage','candidate.approve','risk.accept','send.accept_extras','audit.read','contract.read','contract.link','contract.manage','mail.read','mail.import','mail.link','mail.manage','contract.create','wording.propose','calculation.close']::text[],true);
INSERT INTO portal_role(id,code,name,base_role,permissions,built_in) VALUES('00000000-0000-4000-8000-000000000003','admin','Администратор','admin',ARRAY['admin.users','admin.tender','admin.audit','admin.intake','admin.contract','admin.mailbox','admin.delivery','admin.roles','office.read','history.manage','audit.read']::text[],true);
ALTER TABLE user_role DROP CONSTRAINT user_role_role_check;
ALTER TABLE user_role ADD CONSTRAINT user_role_catalog_fk FOREIGN KEY(role) REFERENCES portal_role(code);
CREATE VIEW effective_user_role AS
  SELECT DISTINCT ur.user_id, pr.base_role AS role
    FROM user_role ur JOIN portal_role pr ON pr.code=ur.role WHERE pr.status='active';
GRANT SELECT ON effective_user_role TO kontur_app, kontur_backup;

-- Сохраняем тело существующих охранников и заменяем только чтение системного профиля.
-- Поэтому миграция совместима и с установленными дополнительными этапами.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
  LOOP
    IF f.definition ~* '\m(FROM|JOIN)[[:space:]]+user_role\M' THEN
      EXECUTE regexp_replace(f.definition, '\m(FROM|JOIN)[[:space:]]+user_role\M', '\1 effective_user_role','gi');
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION user_role_permissions(p_user uuid) RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT coalesce(array_agg(DISTINCT cap ORDER BY cap),'{}'::text[])
 FROM app_user u JOIN user_role ur ON ur.user_id=u.id JOIN portal_role pr ON pr.code=ur.role
 CROSS JOIN LATERAL unnest(pr.permissions) AS p(cap)
 WHERE u.id=p_user AND u.kind='human' AND u.status='active' AND pr.status='active'
$$;
CREATE FUNCTION has_role_permission(p_user uuid,p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_permission=ANY(user_role_permissions(p_user))
$$;
CREATE FUNCTION portal_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.built_in<>OLD.built_in THEN
   RAISE EXCEPTION 'Идентификатор и системность роли неизменны' USING ERRCODE='55000';
 END IF;
 IF OLD.built_in AND NEW.base_role<>OLD.base_role THEN
   RAISE EXCEPTION 'Основа системной роли неизменна' USING ERRCODE='55000';
 END IF;
 IF NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Неверная версия роли' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER portal_role_guard BEFORE UPDATE ON portal_role FOR EACH ROW EXECUTE FUNCTION portal_role_guard();
CREATE TRIGGER portal_role_no_delete BEFORE DELETE ON portal_role FOR EACH ROW EXECUTE FUNCTION forbid_mutation('history');
CREATE TRIGGER portal_role_no_truncate BEFORE TRUNCATE ON portal_role FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

CREATE OR REPLACE FUNCTION tender_capabilities(p_user uuid,p_tender uuid) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
 v_role text;v_caps text[]:='{}';v_permissions text[]:=user_role_permissions(p_user);v_all boolean;v_admin boolean;
BEGIN
 IF cardinality(v_permissions)=0 THEN RETURN v_caps;END IF;
 v_admin:='admin.tender'=ANY(v_permissions);
 v_all:='tender.read.all'=ANY(v_permissions) AND 'tender.read'=ANY(v_permissions);
 SELECT m.member_role INTO v_role FROM tender_member m WHERE m.tender_id=p_tender AND m.user_id=p_user AND m.removed_at IS NULL
   AND EXISTS(SELECT 1 FROM effective_user_role r WHERE r.user_id=p_user AND r.role=m.member_role);
 IF v_all AND v_role IS NULL THEN v_caps:=ARRAY['tender.read','requirement.read','fact.read'];END IF;
 IF v_role IS NOT NULL THEN
   v_caps:=v_caps||ARRAY['tender.read','stage.write','source.write','calculation.capture','requirement.read','requirement.create','analysis.run','fact.read','fact.create',
     'review.run','finding.write','economics.compare','change_reason.confirm','application.fill','candidate.create','delivery.manage','mcp.propose'];
 END IF;
 IF v_role='manager' THEN
   v_caps:=v_caps||ARRAY['stage.manage','hold.resolve','requirement.confirm','requirement.decide','requirement.manage','fact.confirm','finding.accept_risk',
     'source_priority.manage','template.manage','candidate.approve','risk.accept','send.accept_extras','calculation.close'];
 END IF;
 IF v_role='engineer' THEN v_caps:=v_caps||ARRAY['candidate.release','send.register'];END IF;
 IF 'audit.read'=ANY(v_permissions) AND (v_role IS NOT NULL OR v_all OR v_admin) THEN v_caps:=v_caps||ARRAY['audit.read'];END IF;
 IF v_admin THEN v_caps:=v_caps||ARRAY['admin.tender'];END IF;
 SELECT coalesce(array_agg(c ORDER BY n),'{}'::text[]) INTO v_caps FROM unnest(v_caps) WITH ORDINALITY x(c,n) WHERE c=ANY(v_permissions);
 RETURN v_caps;
END $$;
CREATE OR REPLACE FUNCTION contract_readable_by(p_user uuid,p_contract uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT has_role_permission(p_user,'contract.read') AND EXISTS(SELECT 1 FROM contract WHERE id=p_contract)
 AND (has_role_permission(p_user,'contract.read.all') OR EXISTS(SELECT 1 FROM contract_access a WHERE a.user_id=p_user AND a.contract_id=p_contract AND a.capability='contract.read' AND a.revoked_at IS NULL))
$$;
CREATE OR REPLACE FUNCTION can_manage_template(p_user uuid,p_tender uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_tender IS NULL THEN has_role_permission(p_user,'admin.templates') ELSE 'template.manage'=ANY(tender_capabilities(p_user,p_tender)) END
$$;
CREATE OR REPLACE FUNCTION can_propose_wording(p_user uuid,p_tender uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_tender IS NULL THEN has_role_permission(p_user,'wording.propose') ELSE 'application.fill'=ANY(tender_capabilities(p_user,p_tender)) END
$$;
CREATE OR REPLACE FUNCTION is_active_admin(p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT user_role_permissions(p_user) && ARRAY['admin.users','admin.roles','admin.tender','admin.audit','admin.intake','admin.contract','admin.mailbox','admin.delivery']
$$;
-- Сохраняем ограничения срока, владельца, лимита и неизменяемости токенов, меняя проверку прав.
DO $role_guards$
DECLARE d text;
BEGIN
 SELECT pg_get_functiondef('api_token_guard()'::regprocedure) INTO d;
 d:=replace(d, $$r.role IN ('engineer', 'manager')$$, $$(user_role_permissions(u.id) && ARRAY['tender.read','contract.read','mail.read','templates.read','history.read'])$$);
 d:=replace(d, $$r.role = 'admin'$$, $$has_role_permission(u.id,'admin.users')$$);
 EXECUTE d;
 SELECT pg_get_functiondef('decision_author_guard()'::regprocedure) INTO d;
 d:=replace(d, 'WHERE u.id = NEW.decided_by AND', 'WHERE has_role_permission(NEW.decided_by,''hold.resolve'') AND u.id = NEW.decided_by AND');
 EXECUTE d;
END $role_guards$;

-- Дополнительный установленный контур общей истории использует те же права.
DO $history_roles$
BEGIN
 IF to_regprocedure('history_actor_can_write(uuid,uuid)') IS NOT NULL THEN
 EXECUTE $fn$CREATE OR REPLACE FUNCTION history_actor_can_write(actor uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE AS $body$
 SELECT CASE WHEN target IS NULL THEN has_role_permission(actor,'history.read') AND has_role_permission(actor,'history.write') ELSE 'source.write'=ANY(tender_capabilities(actor,target)) END
 $body$$fn$;
 EXECUTE $fn$CREATE OR REPLACE FUNCTION history_actor_can_manage(actor uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE AS $body$
 SELECT CASE WHEN target IS NULL THEN has_role_permission(actor,'history.read') AND has_role_permission(actor,'history.manage')
 ELSE history_actor_can_write(actor,target) AND ('admin.tender'=ANY(tender_capabilities(actor,target)) OR 'hold.resolve'=ANY(tender_capabilities(actor,target))) END
 $body$$fn$;
 END IF;
END $history_roles$;
