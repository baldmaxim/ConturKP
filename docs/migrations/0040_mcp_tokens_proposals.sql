-- Этап 16 (D-037; проект docs/architecture/16-mcp-design.md): MCP портала — персональные токены чат-клиентов с областями
-- read / propose и предложения, которые создаёт клиент от имени пользователя и принимает человек.
-- Принятые миграции 0001–0039 не меняются (ADR-002); функция возможностей тендера заменяется целиком.

-- ---------------------------------------------------------------- Права

-- mcp.propose — инженер и руководитель тендера (ADR-006): предложение через чат-клиент. Действия человека
-- (согласование, выпуск, отправка, решения по удержаниям и рискам) токену недоступны: у MCP нет обработчиков этих команд.
-- Таблица повторяет packages/core/src/capabilities.ts.
CREATE OR REPLACE FUNCTION tender_capabilities(p_user uuid, p_tender uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_admin boolean;
  v_role  text;
  v_caps  text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND kind = 'human' AND status = 'active') THEN
    RETURN v_caps;
  END IF;
  v_admin := EXISTS (SELECT 1 FROM user_role WHERE user_id = p_user AND role = 'admin');
  SELECT m.member_role INTO v_role
    FROM tender_member m
   WHERE m.tender_id = p_tender AND m.user_id = p_user AND m.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = m.member_role);
  IF v_role IS NOT NULL THEN
    v_caps := v_caps || ARRAY['tender.read', 'stage.write', 'source.write', 'calculation.capture',
                              'requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create',
                              'review.run', 'finding.write', 'economics.compare', 'change_reason.confirm', 'application.fill',
                              'candidate.create', 'delivery.manage', 'mcp.propose'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage', 'candidate.approve', 'risk.accept',
                              'send.accept_extras'];
  END IF;
  IF v_role = 'engineer' THEN
    v_caps := v_caps || ARRAY['candidate.release', 'send.register'];
  END IF;
  IF v_role = 'manager' OR v_admin THEN
    v_caps := v_caps || ARRAY['audit.read'];
  END IF;
  IF v_admin THEN
    v_caps := v_caps || ARRAY['admin.tender'];
  END IF;
  RETURN v_caps;
END;
$$;

-- ---------------------------------------------------------------- Токены чат-клиентов (проект §3)

-- Сам токен не хранится: только SHA-256 и первые символы для показа в списке. Срок — 7, 30 или 90 дней (D-037 В-16-2).
CREATE TABLE api_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  client_kind   text NOT NULL CHECK (client_kind IN ('codex', 'cursor', 'other')),
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_prefix  text NOT NULL CHECK (length(token_prefix) BETWEEN 4 AND 16),
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'propose'] AND 'read' = ANY (scopes) AND cardinality(scopes) BETWEEN 1 AND 2),
  lifetime_days int NOT NULL CHECK (lifetime_days IN (7, 30, 90)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES app_user (id),
  CONSTRAINT api_token_expiry_check CHECK (expires_at = created_at + make_interval(days => lifetime_days)),
  CONSTRAINT api_token_revoke_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX api_token_user_idx ON api_token (user_id, created_at DESC);

CREATE FUNCTION api_token_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Токен выпускает действующий человек с ролью инженера или руководителя; сразу отозванным он не создаётся.
    IF NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                    WHERE u.id = NEW.user_id AND u.kind = 'human' AND u.status = 'active' AND r.role IN ('engineer', 'manager')) THEN
      RAISE EXCEPTION 'api_token: токен выпускает действующий инженер или руководитель' USING ERRCODE = '42501';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.last_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'api_token: токен создаётся действующим и неиспользованным' USING ERRCODE = '55000';
    END IF;
    -- Не больше пяти действующих токенов у пользователя (D-037 В-16-2); параллельные выпуски сериализуются.
    PERFORM pg_advisory_xact_lock(hashtext('api_token'), hashtext(NEW.user_id::text));
    IF (SELECT count(*) FROM api_token t WHERE t.user_id = NEW.user_id AND t.revoked_at IS NULL AND t.expires_at > now()) >= 5 THEN
      RAISE EXCEPTION 'api_token: у пользователя уже пять действующих токенов' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Меняются только отметка последнего вызова и отзыв; отзыв — один раз.
  IF (NEW.id, NEW.user_id, NEW.name, NEW.client_kind, NEW.token_sha256, NEW.token_prefix, NEW.scopes, NEW.lifetime_days, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.name, OLD.client_kind, OLD.token_sha256, OLD.token_prefix, OLD.scopes, OLD.lifetime_days, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'api_token: изменяются только отметка использования и отзыв' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'api_token: токен уже отозван' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    -- Отзывает владелец или администратор.
    IF NEW.revoked_by IS DISTINCT FROM OLD.user_id
       AND NOT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id WHERE u.id = NEW.revoked_by AND u.kind = 'human' AND u.status = 'active' AND r.role = 'admin') THEN
      RAISE EXCEPTION 'api_token: отзывает владелец или администратор' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_token_guard BEFORE INSERT OR UPDATE ON api_token FOR EACH ROW EXECUTE FUNCTION api_token_guard();
CREATE TRIGGER api_token_no_delete BEFORE DELETE ON api_token FOR EACH ROW EXECUTE FUNCTION forbid_mutation('без удаления');
CREATE TRIGGER api_token_no_truncate BEFORE TRUNCATE ON api_token FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('без удаления');

-- ---------------------------------------------------------------- Предложения из чата (проект §6)

-- Предложение создаёт чат-клиент от имени пользователя; оно ничего не меняет, пока его не принял человек.
-- Уникальность повтора — (пользователь, request_id) (A37).
CREATE TABLE mcp_proposal (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  stage_id             uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('finding', 'question', 'condition_text', 'change_reason')),
  title                text CHECK (length(title) BETWEEN 1 AND 300),
  body                 text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  -- Вид-зависимые коды без свободного текста: подсказка серьёзности, ключ поля, вид причины, вывод сравнения.
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  request_id           text NOT NULL CHECK (length(request_id) BETWEEN 8 AND 200),
  request_sha256       text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  api_token_id         uuid NOT NULL REFERENCES api_token (id),
  on_behalf_of_user_id uuid NOT NULL REFERENCES app_user (id),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  decided_by           uuid REFERENCES app_user (id),
  decided_at           timestamptz,
  decision_reason      text CHECK (length(decision_reason) BETWEEN 1 AND 1000),
  result_type          text CHECK (result_type IN ('finding', 'customer_question', 'release_comparison_reason')),
  result_id            uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_xact         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  row_version          bigint NOT NULL DEFAULT 1,
  CONSTRAINT mcp_proposal_request_key UNIQUE (on_behalf_of_user_id, request_id),
  CONSTRAINT mcp_proposal_stage_fk FOREIGN KEY (stage_id) REFERENCES tender_stage (id),
  CONSTRAINT mcp_proposal_decision_check CHECK ((status = 'open') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT mcp_proposal_result_check CHECK ((result_type IS NULL) = (result_id IS NULL) AND (result_id IS NULL OR status = 'accepted')),
  CONSTRAINT mcp_proposal_reject_check CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
CREATE INDEX mcp_proposal_stage_idx ON mcp_proposal (stage_id, status, created_at DESC);

CREATE TABLE mcp_proposal_fragment (
  proposal_id uuid NOT NULL REFERENCES mcp_proposal (id),
  fragment_id uuid NOT NULL REFERENCES evidence_fragment (id),
  ordinal     int NOT NULL CHECK (ordinal >= 1),
  PRIMARY KEY (proposal_id, fragment_id),
  CONSTRAINT mcp_proposal_fragment_ordinal_key UNIQUE (proposal_id, ordinal)
);

CREATE FUNCTION mcp_proposal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cap text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM tender_stage s WHERE s.id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'mcp_proposal: этап не принадлежит тендеру' USING ERRCODE = '23514';
    END IF;
    -- Токен — действующий, этого пользователя, с областью propose; пользователь вправе предлагать в этом тендере.
    IF NOT EXISTS (SELECT 1 FROM api_token t
                    WHERE t.id = NEW.api_token_id AND t.user_id = NEW.on_behalf_of_user_id AND t.revoked_at IS NULL AND t.expires_at > now()
                      AND 'propose' = ANY (t.scopes)) THEN
      RAISE EXCEPTION 'mcp_proposal: нужен действующий токен пользователя с областью propose' USING ERRCODE = '42501';
    END IF;
    IF NOT coalesce('mcp.propose' = ANY (tender_capabilities(NEW.on_behalf_of_user_id, NEW.tender_id)), false) THEN
      RAISE EXCEPTION 'mcp_proposal: предлагает инженер или руководитель тендера (mcp.propose)' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'open' OR NEW.decided_by IS NOT NULL OR NEW.result_id IS NOT NULL OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'mcp_proposal: предложение создаётся открытым' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Содержимое неизменно; открытое предложение один раз становится принятым или отклонённым решением человека.
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.kind, NEW.title, NEW.body, NEW.detail, NEW.request_id, NEW.request_sha256, NEW.api_token_id,
      NEW.on_behalf_of_user_id, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.kind, OLD.title, OLD.body, OLD.detail, OLD.request_id, OLD.request_sha256, OLD.api_token_id,
      OLD.on_behalf_of_user_id, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'mcp_proposal: содержимое предложения неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('accepted', 'rejected') OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'mcp_proposal: решение принимается один раз по открытому предложению' USING ERRCODE = '55000';
  END IF;
  -- Решает человек тендера с возможностью, которая нужна для такой записи в портале; модель решить не может (I12).
  v_cap := CASE OLD.kind WHEN 'finding' THEN 'finding.write' WHEN 'question' THEN 'requirement.create'
                         WHEN 'condition_text' THEN 'application.fill' ELSE 'change_reason.confirm' END;
  IF NEW.decided_by IS NULL OR NOT coalesce(v_cap = ANY (tender_capabilities(NEW.decided_by, OLD.tender_id)), false) THEN
    RAISE EXCEPTION 'mcp_proposal: решение принимает человек тендера с возможностью %', v_cap USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mcp_proposal_guard BEFORE INSERT OR UPDATE ON mcp_proposal FOR EACH ROW EXECUTE FUNCTION mcp_proposal_guard();
CREATE TRIGGER mcp_proposal_no_delete BEFORE DELETE ON mcp_proposal FOR EACH ROW EXECUTE FUNCTION forbid_mutation('без удаления');
CREATE TRIGGER mcp_proposal_no_truncate BEFORE TRUNCATE ON mcp_proposal FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('без удаления');

-- Цитаты предложения: только в транзакции его создания, фрагмент — источника этого тендера; затем неизменны.
CREATE FUNCTION mcp_proposal_fragment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mcp_proposal p WHERE p.id = NEW.proposal_id AND p.status = 'open' AND p.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'mcp_proposal_fragment: цитаты записываются вместе с предложением' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mcp_proposal_fragment_guard BEFORE INSERT ON mcp_proposal_fragment FOR EACH ROW EXECUTE FUNCTION mcp_proposal_fragment_guard();
CREATE TRIGGER mcp_proposal_fragment_immutable BEFORE UPDATE OR DELETE ON mcp_proposal_fragment FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER mcp_proposal_fragment_no_truncate BEFORE TRUNCATE ON mcp_proposal_fragment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Журнал

-- Вызов через чат-клиент: участник — «модель через MCP», всегда от имени пользователя (ADR-010).
ALTER TABLE audit_event ADD CONSTRAINT audit_event_mcp_on_behalf_check
  CHECK (principal_kind <> 'model_via_mcp' OR on_behalf_of_user_id IS NOT NULL) NOT VALID;
ALTER TABLE audit_event VALIDATE CONSTRAINT audit_event_mcp_on_behalf_check;

-- ---------------------------------------------------------------- Статус интеграций и права роли приложения

-- MCP-сервер портала проверяется официальным клиентом SDK (это проверка протокола, а не чат-клиента). Codex и Cursor —
-- отдельные строки: настройка описана, живая проверка каждого клиента выполняется отдельно (D-037 В-16-1, Q-12).
INSERT INTO integration_status (system, component, status, details)
VALUES ('mcp', 'PortalMcpServer', 'VERIFIED_FIXTURE', '{"note": "протокол проверен официальным клиентом SDK; подключением чат-клиента это не является"}'::jsonb),
       ('codex', 'McpClient', 'NOT_IMPLEMENTED', '{"note": "живая проверка клиента не выполнялась (Q-12)"}'::jsonb),
       ('cursor', 'McpClient', 'NOT_IMPLEMENTED', '{"note": "живая проверка клиента не выполнялась (Q-12)"}'::jsonb)
ON CONFLICT (system, component) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details, updated_at = now();

GRANT SELECT, INSERT, UPDATE ON api_token, mcp_proposal TO kontur_app;
GRANT SELECT, INSERT ON mcp_proposal_fragment TO kontur_app;
