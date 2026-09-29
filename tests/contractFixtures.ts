// Фикстуры договорного контура (этап 06a): выдачи, договоры, документы, связи — через API, как
// это делает пользователь. Тексты договоров синтетические.
import { expect } from 'vitest';
import { idem, type TestClient } from './helpers.ts';
import { fakePdf } from './zip.ts';

export const octet = { 'Content-Type': 'application/octet-stream' };

export const grantCreator = async (admin: TestClient, userId: string): Promise<void> => {
  const r = await admin.put(`/admin/contract-creators/${userId}`, {});
  expect(r.status, r.text).toBe(200);
};

export const createContract = async (client: TestClient, number: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await client.post('/contracts', { number, title: `Договор ${number}`, ...extra }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};

export const etagOf = async (client: TestClient, path: string): Promise<string> => {
  const r = await client.get(path);
  expect(r.status, r.text).toBe(200);
  return r.headers.etag as string;
};

// Полный набор возможностей пользователя по договору (администратор договоров).
export const setAccess = async (admin: TestClient, contractId: string, userId: string, capabilities: string[]) => {
  const r = await admin.put(`/contracts/${contractId}/access/${userId}`, { capabilities }, { headers: { 'If-Match': await etagOf(admin, `/contracts/${contractId}`) } });
  expect(r.status, r.text).toBe(200);
  return r;
};

export const uploadContractDocument = (
  client: TestClient,
  contractId: string,
  name: string,
  body: Buffer,
  o: { role?: 'contract' | 'addendum' | 'appendix'; mainDocumentId?: string; title?: string } = {},
) => {
  const q = new URLSearchParams({ name, role: o.role ?? 'contract', ...(o.mainDocumentId ? { mainDocumentId: o.mainDocumentId } : {}), ...(o.title ? { title: o.title } : {}) });
  return client.post(`/contracts/${contractId}/documents?${q.toString()}`, body, { headers: { ...octet, ...idem() } });
};

export const uploadContractRevision = (client: TestClient, documentId: string, name: string, body: Buffer) =>
  client.post(`/contract-documents/${documentId}/revisions?name=${encodeURIComponent(name)}`, body, { headers: { ...octet, ...idem() } });

// Основной документ договора: возвращает документ и его первую редакцию.
export const uploadMain = async (client: TestClient, contractId: string, name = 'договор.pdf', body = fakePdf(`${contractId}-${name}`)) => {
  const r = await uploadContractDocument(client, contractId, name, body);
  expect(r.status, r.text).toBe(201);
  return { documentId: r.body.documentId as string, revisionId: r.body.revisionId as string };
};

export const linkContract = async (client: TestClient, contractId: string, tenderId: string, extra: Record<string, unknown> = {}) => {
  const r = await client.post(`/contracts/${contractId}/tenders`, { tenderId, ...extra }, { headers: idem() });
  expect([200, 201], r.text).toContain(r.status);
  return { id: r.body.id as string, etag: r.headers.etag as string };
};

export const contractSearch = (client: TestClient, contractId: string, query: string, limit = 10) =>
  client.post('/search', { context: { kind: 'contract', contractId }, query, limit }, { headers: idem() });

// Тексты найденных фрагментов итога (терминальный прогон без смысловой ветки — сразу fused).
export const hitTexts = (body: { fused: { items: { text: string }[] } | null; lexical: { items: { text: string }[] } | null }): string[] =>
  (body.fused?.items ?? body.lexical?.items ?? []).map((h) => h.text);
