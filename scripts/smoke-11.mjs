// Шаги smoke этапа 11 (D-031): приложения на реальных server + worker. Руководитель создаёт демонстрационный шаблон
// компании и утверждает ревизию схемы forms/1 (вымышленный текст в структуре реальных форм; реальные формы — вне Git);
// инженер создаёт приложение этапа, вносит значение, «заполнено» с пустыми обязательными полями отвергается списком
// незавершённых пунктов; второй редактор по прежней версии поля получает 412. Вызывается из scripts/smoke.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const smokeForms = async ({ root, api, api2, record, idem, json, stageId }) => {
  const schema = JSON.parse(readFileSync(join(root, 'docs/forms/demo-key-conditions.forms.json'), 'utf8'));
  const t = await api('/application-templates', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ ownerKind: 'company', name: 'Ключевые условия (демо)', isDemo: true }) });
  const tBody = t.status === 201 ? await t.json() : null;
  const r = tBody ? await api(`/application-templates/${tBody.id}/revisions`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ schema }) }) : null;
  const rBody = r?.status === 201 ? await r.json() : null;
  const a = rBody ? await api(`/template-revisions/${rBody.id}/approve`, { method: 'POST', headers: { ...json, 'If-Match': r.headers.get('etag') }, body: '{}' }) : null;
  record('этап 11: демонстрационный шаблон компании, ревизия forms/1 утверждена руководителем', a?.status === 200, `HTTP ${t.status}/${r?.status}/${a?.status}`);

  const d = rBody ? await api2(`/stages/${stageId}/application-drafts`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ templateRevisionId: rBody.id, title: 'Ключевые условия' }) }) : null;
  const draft = d?.status === 201 ? await d.json() : null;
  const field = draft?.sections.flatMap((s) => s.fields).find((f) => f.key === 'advance_percent');
  const set = field ? await api2(`/application-drafts/${draft.id}/fields/advance_percent`, { method: 'PUT', headers: { ...json, 'If-Match': field.etag }, body: JSON.stringify({ action: 'set', value: '30', bases: [] }) }) : null;
  const second = field ? await api(`/application-drafts/${draft.id}/fields/advance_percent`, { method: 'PUT', headers: { ...json, 'If-Match': field.etag }, body: JSON.stringify({ action: 'set', value: '20', bases: [] }) }) : null;
  record('этап 11: инженер создал приложение и внёс значение; второй редактор по прежней версии — 412', d?.status === 201 && set?.status === 200 && second?.status === 412, `HTTP ${d?.status}/${set?.status}/${second?.status}`);

  const view = draft ? await (await api2(`/application-drafts/${draft.id}`)).json() : null;
  const complete = view ? await api2(`/application-drafts/${draft.id}/complete`, { method: 'POST', headers: { ...json, 'If-Match': view.etag }, body: '{}' }) : null;
  const cBody = complete ? await complete.json() : null;
  const required = (cBody?.current?.issues ?? []).filter((i) => i.kind === 'required_empty').length;
  record(
    'этап 11: «заполнено» с пустыми обязательными полями — 409 со списком незавершённых пунктов; демо-приложение помечено',
    complete?.status === 409 && cBody?.current?.reason === 'incomplete' && required > 0 && view?.template?.isDemo === true,
    `обязательных пустых: ${required}`,
  );
  return { draftId: draft?.id ?? null, blocking: view?.blocking ?? null };
};
