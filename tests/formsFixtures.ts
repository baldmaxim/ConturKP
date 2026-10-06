// Фикстуры этапа 11: демонстрационные формы (вымышленный текст в структуре реальных форм компании) и шаги API.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { IFormSchema } from '../packages/core/src/index.ts';
import { idem, type TestClient } from './helpers.ts';

export const demoSchema = (name: 'demo-key-conditions' | 'demo-kp-letter'): IFormSchema => JSON.parse(readFileSync(`docs/forms/${name}.forms.json`, 'utf8')) as IFormSchema;

export interface IFieldView {
  fieldId: string;
  key: string;
  applicable: boolean;
  required: boolean;
  version: number;
  etag: string;
  latest: {
    id: string;
    version: number;
    value: unknown;
    state: string;
    origin: string;
    restricted: boolean;
    stale: boolean;
    wording: { versionId: string; version: number; title: string; newerApproved: boolean } | null;
    comment: string | null;
    customerQuestionId: string | null;
    bases: { basisType: string; fragmentId: string | null; decisionId: string | null; problem: string | null; quote: string | null }[];
    invalidations: { reason: string }[];
  } | null;
  systemProposals: { evidenceFactId: string; value: unknown; restricted: boolean }[];
  suggestions: { id: string; status: string; value: unknown; restricted: boolean; etag: string; evidence: { fragmentId: string; quote: string | null }[] }[];
}

export interface IDraftView {
  id: string;
  title: string;
  status: string;
  etag: string;
  template: { id: string; isDemo: boolean; revisionId: string; newerRevisionAvailable: boolean; currentRevisionId: string | null };
  sections: { key: string; fields: IFieldView[] }[];
  issues: { kind: string; fieldKey: string | null; label: string; blocking: boolean; message: string }[];
  blocking: number;
  migrationReport: Record<string, unknown> | null;
  supersededByDraftId: string | null;
}

export const createTemplateWithRevision = async (
  client: TestClient,
  o: { name: string; schema: unknown; ownerKind?: 'company' | 'customer'; tenderId?: string | null; isDemo?: boolean; approve?: boolean; basisFragmentIds?: string[] },
) => {
  const t = await client.post('/application-templates', { ownerKind: o.ownerKind ?? 'company', tenderId: o.tenderId ?? null, name: o.name, isDemo: o.isDemo ?? true }, { headers: idem() });
  expect(t.status, t.text).toBe(201);
  const r = await client.post(`/application-templates/${t.body.id}/revisions`, { schema: o.schema }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  if (o.approve !== false) {
    const a = await client.post(`/template-revisions/${r.body.id}/approve`, { basisFragmentIds: o.basisFragmentIds ?? [] }, { headers: { 'If-Match': r.headers.etag as string } });
    expect(a.status, a.text).toBe(200);
  }
  return { templateId: t.body.id as string, revisionId: r.body.id as string, etag: r.headers.etag as string };
};

export const createDraft = async (client: TestClient, stageId: string, revisionId: string, title?: string): Promise<IDraftView> => {
  const r = await client.post(`/stages/${stageId}/application-drafts`, { templateRevisionId: revisionId, ...(title ? { title } : {}) }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as IDraftView;
};

export const draftOf = async (client: TestClient, draftId: string): Promise<IDraftView> => {
  const r = await client.get(`/application-drafts/${draftId}`);
  expect(r.status, r.text).toBe(200);
  return r.body as IDraftView;
};

export const fieldOf = (d: IDraftView, key: string): IFieldView => d.sections.flatMap((s) => s.fields).find((f) => f.key === key)!;

export const act = (client: TestClient, draftId: string, key: string, etag: string, body: Record<string, unknown>) =>
  client.put(`/application-drafts/${draftId}/fields/${key}`, body, { headers: { 'If-Match': etag } });

// Ввод значения по текущей версии поля (перечитывает приложение).
export const setValue = async (client: TestClient, draftId: string, key: string, value: unknown, bases: { type: string; id: string }[] = []) => {
  const f = fieldOf(await draftOf(client, draftId), key);
  const r = await act(client, draftId, key, f.etag, { action: 'set', value, bases });
  expect(r.status, `${key}: ${r.text}`).toBe(200);
  return r.body as { draft: { etag: string; blocking: number; issues: IDraftView['issues'] }; field: IFieldView };
};

export const fillAll = async (client: TestClient, draftId: string, values: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(values)) await setValue(client, draftId, k, v);
};

export const KEY_FILLED: Record<string, unknown> = {
  price_kind: 'firm',
  estimate_units: 'Сметы составляются по этажам и секциям или комплексом работ.',
  site_upkeep_month: '25',
  duration_months: '32',
  advance_percent: '30',
  advance_security: 'none',
  compensation_mechanism: 'inflation',
  inflation_threshold: '5',
  methodology_variant: 'inflation_only',
  warranty_months: '36',
};

export const KP_FILLED: Record<string, unknown> = {
  letter_date: '2026-10-06',
  letter_number: '04/26-01-ТО',
  addressee: 'Тендерному управлению заказчика (демо)',
  subject: 'Строительство демонстрационного объекта',
  materials_price_date: '2026-09-01',
  advance_percent: '30',
  duration_months: '32',
  validity_days: '30',
};
