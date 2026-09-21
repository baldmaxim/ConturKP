// Заморозка состава источников этапа (portal-api §2.3, state-machines §5). Охранное условие:
// у каждой включённой редакции есть завершённое (complete) или явно неполное (partial)
// распознавание. Незавершённый, отказавший и отсутствующий прогон заморозку не дают —
// иначе проверка получила бы вход без доказательств (I18).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceSetContentHash } from '../packages/core/src/index.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, seedRecognition, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const revs: string[] = [];

const upload = async (name: string): Promise<string> => {
  const r = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent(name)}`, fakePdf(name), {
    headers: { 'Content-Type': 'application/octet-stream', ...idem() },
  });
  await drain(makeWorker(db, config));
  return (await s.eng1.get(`/imports/${r.body.id}`)).body.items[0].documentRevisionId as string;
};

// Черновик с заданным составом. Черновик у набора один (уникальный индекс миграции 0002),
// поэтому существующий переиспользуется, а не создаётся заново.
const draftWith = async (items: { documentRevisionId: string; inclusion: string; reason?: string }[]) => {
  const sets = (await s.eng1.get(`/stages/${s.stageA}/source-sets`)).body.items as { revisions: { id: string; status: string; rowVersion: number }[] }[];
  const open = sets[0]?.revisions.find((r) => r.status === 'draft') ?? null;
  let id: string;
  let etag: string;
  if (open) {
    id = open.id;
    etag = `"${open.id}:${open.rowVersion}"`;
  } else {
    const d = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    expect(d.status, d.text).toBe(201);
    id = d.body.id;
    etag = d.headers.etag as string;
  }
  const put = await s.eng1.put(`/source-set-revisions/${id}/items`, { items }, { headers: { 'If-Match': etag } });
  expect(put.status, put.text).toBe(200);
  return { id, etag: put.headers.etag as string };
};

const freeze = (id: string, etag: string, client = s.eng1) =>
  client.post(`/source-set-revisions/${id}/freeze`, {}, { headers: { 'If-Match': etag, ...idem() } });

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  for (const name of ['ТЗ.pdf', 'ПД.pdf', 'Договор.pdf']) revs.push(await upload(name));
});
afterAll(async () => db.drop());

describe('заморозка состава источников', () => {
  it('без распознавания включённой редакции — 409 с перечнем блокирующих', async () => {
    const d = await draftWith([{ documentRevisionId: revs[0]!, inclusion: 'included' }]);
    const r = await freeze(d.id, d.etag);
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe('STATE_CONFLICT');
    expect(r.body.current.blocking).toHaveLength(1);
    expect(r.body.current.blocking[0]).toMatchObject({ documentRevisionId: revs[0], reason: 'no_recognition' });
  });

  it('незавершённое и отказавшее распознавание заморозку не дают', async () => {
    const d = await draftWith([{ documentRevisionId: revs[0]!, inclusion: 'included' }]);
    await seedRecognition(db.pool, revs[0]!, 'running');
    const running = await freeze(d.id, d.etag);
    expect(running.status).toBe(409);
    expect(running.body.current.blocking[0].reason).toBe('recognition_in_progress');

    await seedRecognition(db.pool, revs[1]!, 'failed');
    const d2 = await draftWith([{ documentRevisionId: revs[1]!, inclusion: 'included' }]);
    const failed = await freeze(d2.id, d2.etag);
    expect(failed.status).toBe(409);
    expect(failed.body.current.blocking[0].reason).toBe('recognition_failed');
  });

  it('явно неполное распознавание заморозку разрешает; исключённая редакция его не требует', async () => {
    await seedRecognition(db.pool, revs[0]!, 'partial', { total: 4, recognized: 3 });
    const d = await draftWith([
      { documentRevisionId: revs[0]!, inclusion: 'included' },
      { documentRevisionId: revs[2]!, inclusion: 'excluded_not_applicable', reason: 'договор другого лота' },
    ]);
    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion;
    const r = await freeze(d.id, d.etag);
    expect(r.status, r.text).toBe(200);
    expect(r.body.status).toBe('frozen');
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Заморозка событий барьера не порождает: состав не менялся (state-machines §5).
    expect((await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion).toBe(before);

    // Повторная заморозка — конфликт, а не молчаливый успех.
    const again = await freeze(d.id, r.headers.etag as string);
    expect(again.status).toBe(409);

    // Состав замороженной ревизии дальше не меняется.
    const change = await s.eng1.put(`/source-set-revisions/${d.id}/items`, { items: [] }, { headers: { 'If-Match': r.headers.etag as string } });
    expect(change.status).toBe(409);
  });

  it('пустой состав не замораживается', async () => {
    const d = await draftWith([]);
    const r = await freeze(d.id, d.etag);
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/нет ни одной включённой редакции/);
  });

  it('If-Match обязателен и проверяется', async () => {
    await seedRecognition(db.pool, revs[1]!, 'complete');
    const d = await draftWith([{ documentRevisionId: revs[1]!, inclusion: 'included' }]);
    const noMatch = await s.eng1.post(`/source-set-revisions/${d.id}/freeze`, {}, { headers: idem() });
    expect(noMatch.status).toBe(428);
    const stale = await freeze(d.id, `"${d.id}:1"`);
    expect(stale.status).toBe(412);
    const ok = await freeze(d.id, d.etag);
    expect(ok.status, ok.text).toBe(200);
  });

  it('чужой тендер не видит ревизию', async () => {
    const d = await draftWith([]);
    expect((await freeze(d.id, d.etag, s.eng3)).status).toBe(404);
  });

  it('хэш состава не зависит от порядка и меняется при смене решения', () => {
    const a = { documentRevisionId: 'b', blobSha256: '02', inclusion: 'included' };
    const b = { documentRevisionId: 'a', blobSha256: '01', inclusion: 'included' };
    expect(sourceSetContentHash([a, b])).toBe(sourceSetContentHash([b, a]));
    expect(sourceSetContentHash([a, b])).not.toBe(sourceSetContentHash([a, { ...b, inclusion: 'excluded_not_applicable' }]));
    // Прогоны распознавания в хэш состава не входят (их фиксирует снимок области, этап 05).
    expect(sourceSetContentHash([a])).not.toBe(sourceSetContentHash([{ ...a, blobSha256: '03' }]));
  });
});
