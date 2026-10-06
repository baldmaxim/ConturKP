// Фикстуры этапа 12: конвертер LibreOffice обязателен (D-032 В-12-2) — его отсутствие не пропускает тесты молча, а
// роняет их с понятной причиной. Путь — KONTUR_TEST_SOFFICE или поиск как у worker (PATH, стандартный каталог Windows).
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { IOfficeConverter } from '../packages/adapters/src/index.ts';
import { createOfficeConverter } from '../apps/worker/src/office/libreoffice.ts';
import { idem, type TestClient } from './helpers.ts';

export const TEST_SOFFICE = process.env.KONTUR_TEST_SOFFICE ?? null;

export const requireConverter = (): IOfficeConverter => {
  const c = createOfficeConverter({ sofficePath: TEST_SOFFICE, convertTimeoutMs: 120_000 });
  if (!c) throw new Error('LibreOffice не найден: установите LibreOffice (soffice) или задайте KONTUR_TEST_SOFFICE — без конвертера комплект не собирается (D-032 В-12-2)');
  return c;
};

export const SAMPLES = {
  letterMarked: 'docs/forms/samples/demo-kp-letter.marked.docx',
  letterOriginal: 'docs/forms/samples/demo-kp-letter.original.docx',
  conditionsMarked: 'docs/forms/samples/demo-key-conditions.marked.xlsx',
  conditionsOriginal: 'docs/forms/samples/demo-key-conditions.original.xlsx',
} as const;

// Загрузка файла образца или вложения (тот, кто ведёт шаблоны).
export const uploadSample = async (client: TestClient, bytes: Buffer, name: string): Promise<string> => {
  const r = await client.post(`/form-samples?name=${encodeURIComponent(name)}`, bytes, { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
  expect(r.status, r.text).toBe(201);
  return r.body.sha256 as string;
};

export const uploadSampleFile = async (client: TestClient, path: string) => uploadSample(client, readFileSync(path), path.split('/').pop()!);

export interface IRevisionView {
  id: string;
  status: string;
  outputFormat: string | null;
  audience: string;
  markup: { ok: boolean; issues: { code: string }[] } | null;
  etag: string;
}

// Шаблон с ревизией: схема, исходный и размеченный образец; утверждение — если разметка проверена.
export const templateWithMarkedSample = async (
  manager: TestClient,
  o: { name: string; schema: unknown; marked: string | Buffer; original?: string; audience?: 'customer' | 'internal'; isDemo?: boolean; approve?: boolean },
): Promise<{ templateId: string; revision: IRevisionView }> => {
  const t = await manager.post('/application-templates', { ownerKind: 'company', name: o.name, isDemo: o.isDemo ?? true }, { headers: idem() });
  expect(t.status, t.text).toBe(201);
  const markedSha = typeof o.marked === 'string' ? await uploadSampleFile(manager, o.marked) : await uploadSample(manager, o.marked, 'marked.docx');
  const originalSha = o.original ? await uploadSampleFile(manager, o.original) : null;
  const r = await manager.post(
    `/application-templates/${t.body.id}/revisions`,
    { schema: o.schema, ...(originalSha ? { sample: { sha256: originalSha, name: o.original!.split('/').pop()! } } : {}), markedSample: { sha256: markedSha, name: 'размеченная копия' }, audience: o.audience ?? 'customer' },
    { headers: idem() },
  );
  expect(r.status, r.text).toBe(201);
  let revision = { ...(r.body as IRevisionView), etag: r.headers.etag as string };
  if (o.approve !== false && revision.markup?.ok) {
    const a = await manager.post(`/template-revisions/${revision.id}/approve`, { basisFragmentIds: [] }, { headers: { 'If-Match': revision.etag } });
    expect(a.status, a.text).toBe(200);
    revision = { ...(a.body as IRevisionView), etag: a.headers.etag as string };
  }
  return { templateId: t.body.id as string, revision };
};

export const completeDraft = async (client: TestClient, draftId: string) => {
  const d = await client.get(`/application-drafts/${draftId}`);
  expect(d.status, d.text).toBe(200);
  const r = await client.post(`/application-drafts/${draftId}/complete`, {}, { headers: { 'If-Match': d.body.etag as string } });
  expect(r.status, r.text).toBe(200);
};

export interface ICandidateView {
  id: string;
  seq: number;
  mode: string;
  status: string;
  restricted: boolean;
  failure: { code: string; detail: string } | null;
  converterVersion: string | null;
  contentHash: string | null;
  checks: { code: string; outcome: string; path: string | null; detail: string | null }[];
  files: { id: string; path: string; role: string; audience: string; mediaType: string; sizeBytes: number; sha256: string; previewFileId: string | null }[];
  previews: { id: string; path: string; sourceFileId: string; sha256: string; pages: number; fonts: string[] }[];
  notes: string[];
  knownProductionBlockers: string[];
  eventsAfter: { seq: number; type: string; affects: boolean }[];
  current: boolean;
  inputs: { drafts: { id: string }[]; fieldVersions: number; reviewRun: { id: string } | null; decisions: number; attachments: { revisionId: string }[] };
}
