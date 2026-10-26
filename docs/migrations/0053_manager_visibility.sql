-- Автоматический просмотр руководителя для установленной схемы 0052.
-- Существующие права изменения сохранены, включая calculation.close по назначению.

CREATE OR REPLACE FUNCTION tender_capabilities(p_user uuid, p_tender uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_admin boolean;
  v_manager boolean;
  v_role  text;
  v_caps  text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND kind = 'human' AND status = 'active') THEN
    RETURN v_caps;
  END IF;
  v_admin := EXISTS (SELECT 1 FROM user_role WHERE user_id = p_user AND role = 'admin');
  v_manager := EXISTS (SELECT 1 FROM user_role WHERE user_id = p_user AND role = 'manager');
  SELECT m.member_role INTO v_role
    FROM tender_member m
   WHERE m.tender_id = p_tender AND m.user_id = p_user AND m.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = m.member_role);
  IF v_manager AND v_role IS NULL THEN
    v_caps := v_caps || ARRAY['tender.read', 'requirement.read', 'fact.read'];
  END IF;
  IF v_role IS NOT NULL THEN
    v_caps := v_caps || ARRAY['tender.read', 'stage.write', 'source.write', 'calculation.capture',
                              'requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create',
                              'review.run', 'finding.write', 'economics.compare', 'change_reason.confirm', 'application.fill',
                              'candidate.create', 'delivery.manage', 'mcp.propose'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage', 'candidate.approve', 'risk.accept',
                              'send.accept_extras', 'calculation.close'];
  END IF;
  IF v_role = 'engineer' THEN
    v_caps := v_caps || ARRAY['candidate.release', 'send.register'];
  END IF;
  IF v_manager OR v_admin THEN
    v_caps := v_caps || ARRAY['audit.read'];
  END IF;
  IF v_admin THEN
    v_caps := v_caps || ARRAY['admin.tender'];
  END IF;
  RETURN v_caps;
END;
$$;

CREATE OR REPLACE FUNCTION contract_readable_by(p_user uuid, p_contract uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user u
     WHERE u.id = p_user AND u.kind = 'human' AND u.status = 'active'
       AND (EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = 'manager')
         OR (EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = 'engineer')
           AND EXISTS (SELECT 1 FROM contract_access a WHERE a.contract_id = p_contract AND a.user_id = p_user
                         AND a.capability = 'contract.read' AND a.revoked_at IS NULL)))
  ) AND EXISTS (SELECT 1 FROM contract WHERE id = p_contract)
$$;
