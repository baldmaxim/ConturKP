// Импорт источников (этап 03): A13, A14, A38, события барьера, исходы элементов (RT-08, часть этапа 03).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditRows,
  buildScenario,
  createTestDb,
  drain,
  idem,
  makeApp,
  makeWorker,
  testConfig,
  TestClient,
  type IScenario,
  type ITestDb,
} from './helpers.ts';
import { buildZip, fakePdf, fakePng } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let app: ReturnType<typeof makeApp>;
const config = testConfig();
let worker: ReturnType<typeof makeWorker>;

const upload = (c: TestClient, stageId: string, name: string, data: Buffer, key?: string) =>
  c.post(`/stages/${stageId}/imports?name=${encodeURIComponent(name)}`, data, {
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key ?? idem()['Idempotency-Key'] },
  });

const importAndProcess = async (c: TestClient, stageId: string, name: string, data: Buffer) => {
  const r = await upload(c, stageId, name, data);
  expect(r.status, r.text).toBe(202);
  await drain(worker);
  const b = await c.get(`/imports/${r.body.id}`);
  return b.body;
};

const events = async (stageId: string) =>
  (await db.pool.query<{ event_type: string; ref_id: string }>('SELECT event_type, ref_id FROM stage_input_event WHERE stage_id = $1 ORDER BY seq', [stageId])).rows;

beforeAll(async () => {
  db = await createTestDb();
  app = makeApp(db, undefined, config);
  worker = makeWorker(db, config);
  s = await buildScenario(db, app);
});
afterAll(async () => db.drop());

describe('регистрация оригиналов и редакций', () => {
  it('загрузка PDF → партия, событие import_accepted, редакция и событие регистрации', async () => {
    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion;
    const r = await upload(s.eng1, s.stageA, 'ТЗ.pdf', fakePdf('тз v1'));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('running');
    const accepted = await events(s.stageA);
    expect(accepted.at(-1)).toMatchObject({ event_type: 'import_accepted', ref_id: r.body.id });
    await drain(worker);
    const b = (await s.eng1.get(`/imports/${r.body.id}`)).body;
    expect(b.status).toBe('completed');
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ status: 'registered', memberPath: 'ТЗ.pdf' });
    const ev = await events(s.stageA);
    expect(ev.at(-1)).toMatchObject({ event_type: 'document_revision_registered', ref_id: b.items[0].documentRevisionId });
    expect((await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion).toBe(before + 2);
  });

  it('A14: то же содержимое под другим именем — дубликат, одна редакция, два происхождения, без нового события', async () => {
    const evBefore = (await events(s.stageA)).length;
    const b = await importAndProcess(s.eng2, s.stageA, 'Техническое задание (копия).pdf', fakePdf('тз v1'));
    expect(b.items[0].status).toBe('duplicate');
    const docs = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items;
    expect(docs).toHaveLength(1);
    const doc = (await s.eng1.get(`/documents/${docs[0].id}`)).body;
    expect(doc.revisionList).toHaveLength(1);
    expect(doc.revisionList[0].occurrences.map((o: { observedName: string }) => o.observedName)).toEqual(['ТЗ.pdf', 'Техническое задание (копия).pdf']);
    const ev = await events(s.stageA);
    expect(ev.length).toBe(evBefore + 1); // только import_accepted
  });

  it('A13: то же имя, новое содержимое — новая редакция, прежняя доступна', async () => {
    const b = await importAndProcess(s.eng1, s.stageA, 'ТЗ.pdf', fakePdf('тз v2'));
    expect(b.items[0].status).toBe('registered');
    const docs = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items;
    expect(docs).toHaveLength(1);
    const doc = (await s.eng1.get(`/documents/${docs[0].id}`)).body;
    expect(doc.revisionList.map((r: { revisionSeq: number }) => r.revisionSeq)).toEqual([2, 1]);
    expect(doc.revisionList[0].supersedesRevisionId).toBe(doc.revisionList[1].id);
    const old = await s.eng1.get(`/document-revisions/${doc.revisionList[1].id}/content`);
    expect(old.status).toBe(200);
    expect(old.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(old.body).toString('utf8')).toContain('тз v1');
  });

  it('повтор загрузки с тем же ключом не создаёт вторую партию', async () => {
    const key = idem()['Idempotency-Key'];
    const a = await upload(s.eng1, s.stageA, 'повтор.pdf', fakePdf('повтор'), key);
    const b = await upload(s.eng1, s.stageA, 'повтор.pdf', fakePdf('повтор'), key);
    expect(b.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    const other = await upload(s.eng1, s.stageA, 'повтор.pdf', fakePdf('другое'), key);
    expect(other.status).toBe(422);
    await drain(worker);
  });

  it('хранилище: один файл на содержимое, атрибут «только чтение», временных файлов не осталось', async () => {
    const sha = (await db.pool.query<{ blob_sha256: string }>("SELECT blob_sha256 FROM document_revision LIMIT 1")).rows[0]!.blob_sha256;
    const { statSync } = await import('node:fs');
    const st = statSync(join(config.storageRoot, 'sha256', sha.slice(0, 2), sha.slice(2, 4), sha));
    expect(st.mode & 0o200).toBe(0);
    expect(readdirSync(join(config.storageRoot, 'tmp'))).toEqual([]);
  });
});

describe('безопасность архивов и типов (A38)', () => {
  it('../, абсолютный путь, имя устройства, ссылка и шифрование отклоняются по элементу; хорошие элементы регистрируются', async () => {
    const zip = buildZip([
      { name: 'Проект/ПД-01.pdf', data: fakePdf('пд 01'), deflate: true },
      { name: '../../evil.pdf', data: fakePdf('evil') },
      { name: 'C:/Windows/evil.pdf', data: fakePdf('evil2') },
      { name: '/etc/passwd.txt', data: Buffer.from('x') },
      { name: 'dir/CON.txt', data: Buffer.from('x') },
      { name: 'link.pdf', data: Buffer.from('/etc/passwd'), symlink: true },
      { name: 'secret.pdf', data: fakePdf('s'), encrypted: true },
    ]);
    const b = await importAndProcess(s.eng1, s.stageA, 'комплект.zip', zip);
    const by = Object.fromEntries(b.items.map((i: { memberPath: string }) => [i.memberPath, i]));
    expect(by['Проект/ПД-01.pdf'].status).toBe('registered');
    expect(by['../../evil.pdf']).toMatchObject({ status: 'rejected', rejectReason: 'path_traversal' });
    expect(by['C:/Windows/evil.pdf']).toMatchObject({ status: 'rejected', rejectReason: 'path_traversal' });
    expect(by['/etc/passwd.txt']).toMatchObject({ status: 'rejected', rejectReason: 'path_traversal' });
    expect(by['dir/CON.txt']).toMatchObject({ status: 'rejected', rejectReason: 'path_traversal' });
    expect(by['link.pdf']).toMatchObject({ status: 'rejected', rejectReason: 'path_traversal' });
    expect(by['secret.pdf']).toMatchObject({ status: 'rejected', rejectReason: 'type_not_allowed' });
    expect(b.status).toBe('completed_with_errors');
    const files = readdirSync(config.storageRoot);
    expect(files.sort()).toEqual(['derived', 'sha256', 'tmp']);
  });

  it('имена в CP866 без флага UTF-8 декодируются', async () => {
    const name = Buffer.from([0x8f, 0xe0, 0xae, 0xa5, 0xaa, 0xe2, 0x2e, 0x70, 0x64, 0x66]); // «Проект.pdf» в CP866
    const b = await importAndProcess(s.eng1, s.stageA, 'cp866.zip', buildZip([{ name, data: fakePdf('cp866') }]));
    expect(b.items[0]).toMatchObject({ memberPath: 'Проект.pdf', status: 'registered' });
  });

  it('недопустимые типы, вложенный архив, подмена расширения, пустой файл', async () => {
    const zip = buildZip([
      { name: 'setup.exe', data: Buffer.from('MZ\x90\x00') },
      { name: 'script.js', data: Buffer.from('alert(1)') },
      { name: 'image.svg', data: Buffer.from('<svg onload="alert(1)"/>') },
      { name: 'inner.zip', data: buildZip([{ name: 'a.pdf', data: fakePdf('a') }]) },
      { name: 'fake.pdf', data: Buffer.from('not a pdf') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'drawing.png', data: fakePng() },
      { name: 'data.rar', data: Buffer.from('Rar!\x1a\x07\x00') },
    ]);
    const b = await importAndProcess(s.eng1, s.stageA, 'типы.zip', zip);
    const by = Object.fromEntries(b.items.map((i: { memberPath: string; rejectReason: string | null; status: string }) => [i.memberPath, i.rejectReason ?? i.status]));
    expect(by).toEqual({
      'setup.exe': 'type_not_allowed',
      'script.js': 'type_not_allowed',
      'image.svg': 'type_not_allowed',
      'inner.zip': 'type_not_allowed',
      'fake.pdf': 'corrupt',
      'empty.txt': 'corrupt',
      'drawing.png': 'registered',
      'data.rar': 'type_not_allowed',
    });
  });

  it('лимиты: заявленный размер, коэффициент сжатия (zip-бомба), фактический размер больше заявленного', async () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0); // 8 МиБ нулей сжимаются в ~8 КиБ
    const zip = buildZip([
      { name: 'bomb.txt', data: bomb, deflate: true },
      { name: 'declared-huge.pdf', data: fakePdf('x'), deflate: true, declaredSize: 64 * 1024 * 1024 },
      { name: 'liar.txt', data: Buffer.alloc(200_000, 0x41), deflate: true, declaredSize: 1000 },
    ]);
    const b = await importAndProcess(s.eng1, s.stageA, 'лимиты.zip', zip);
    const by = Object.fromEntries(b.items.map((i: { memberPath: string }) => [i.memberPath, i]));
    expect(by['bomb.txt']).toMatchObject({ status: 'rejected', rejectReason: 'size_limit' });
    expect(by['declared-huge.pdf']).toMatchObject({ status: 'rejected', rejectReason: 'size_limit' });
    expect(by['liar.txt']).toMatchObject({ status: 'rejected', rejectReason: 'corrupt' });
  });

  it('большой архив: 1500 элементов разбираются; сверх лимита числа элементов — явный отказ', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ name: `big/doc-${i}.txt`, data: Buffer.from(`документ ${i}`) }));
    const t0 = Date.now();
    const b = await importAndProcess(s.eng1, s.stageA, 'большой.zip', buildZip(many));
    expect(b.status).toBe('completed');
    expect(b.counts.registered).toBe(1500);
    expect(Date.now() - t0).toBeLessThan(120_000);

    const limited = testConfig({ storageRoot: config.storageRoot, limits: { ...config.limits, maxArchiveEntries: 10 } });
    const w = makeWorker(db, limited, 'limited-worker');
    const r = await upload(s.eng1, s.stageA, 'сверх.zip', buildZip(Array.from({ length: 25 }, (_, i) => ({ name: `x/${i}.txt`, data: Buffer.from(`сверх ${i}`) }))));
    await drain(w);
    const lb = (await s.eng1.get(`/imports/${r.body.id}`)).body;
    expect(lb.items.filter((i: { status: string }) => i.status === 'registered')).toHaveLength(10);
    expect(lb.items.find((i: { rejectReason: string }) => i.rejectReason === 'size_limit')?.rejectDetail).toMatch(/больше 10 элементов/);
  }, 180_000);

  it('повтор имени внутри архива — отдельный отказ, а не молчаливая потеря', async () => {
    const b = await importAndProcess(s.eng1, s.stageA, 'дубли-имён.zip', buildZip([{ name: 'X.pdf', data: fakePdf('x1') }, { name: 'X.pdf', data: fakePdf('x2') }]));
    const by = Object.fromEntries(b.items.map((i: { memberPath: string }) => [i.memberPath, i]));
    expect(by['X.pdf'].status).toBe('registered');
    expect(by['X.pdf (#2)']).toMatchObject({ status: 'rejected', rejectReason: 'corrupt' });
  });

  it('повреждённый архив — отказ corrupt с исходом, а не пропажа', async () => {
    const b = await importAndProcess(s.eng1, s.stageA, 'битый.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)]));
    expect(b.status).toBe('completed_with_errors');
    expect(b.items[0]).toMatchObject({ status: 'rejected', rejectReason: 'corrupt' });
  });

  it('HTML отдаётся только скачиванием и в песочнице CSP без скриптов', async () => {
    const b = await importAndProcess(s.eng1, s.stageA, 'письмо.html', Buffer.from('<html><script>fetch("http://127.0.0.1:5432")</script><img src="http://intranet/x"></html>'));
    const rev = b.items[0].documentRevisionId;
    const r = await s.eng1.get(`/document-revisions/${rev}/content`);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(r.headers['content-security-policy']).toMatch(/sandbox; default-src 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('права на источники', () => {
  it('чужой тендер: загрузка, партия, документ, содержимое — 404; отказ в журнале', async () => {
    expect((await upload(s.eng3, s.stageA, 'чужое.pdf', fakePdf('x'))).status).toBe(404);
    const batch = (await s.eng1.get(`/stages/${s.stageA}/imports`)).body.items[0];
    expect((await s.eng3.get(`/imports/${batch.id}`)).status).toBe(404);
    const doc = (await s.eng1.get(`/stages/${s.stageA}/documents`)).body.items[0];
    expect((await s.eng3.get(`/documents/${doc.id}`)).status).toBe(404);
    expect((await s.eng3.get(`/document-revisions/${doc.latestRevisionId}/content`)).status).toBe(404);
    expect((await s.admin.get(`/document-revisions/${doc.latestRevisionId}/content`)).status).toBe(404);
    const denied = await auditRows(db.pool, "actor_user_id = $1 AND action = 'source.import.accept' AND outcome = 'denied'", [s.ids.eng3]);
    expect(denied).toHaveLength(1);
  });

  it('загрузка больше лимита — 413, партия не создаётся', async () => {
    const small = testConfig({ storageRoot: config.storageRoot, limits: { ...config.limits, maxUploadBytes: 1024 } });
    const c = new TestClient(makeApp(db, undefined, small));
    await c.login('eng1');
    const before = (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batch')).rows[0]!.n;
    const r = await upload(c, s.stageA, 'big.pdf', Buffer.concat([fakePdf('x'), Buffer.alloc(4096)]));
    expect(r.status).toBe(413);
    expect((await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batch')).rows[0]!.n).toBe(before);
  });
});

describe('исход элементов партии (R01-09, state-machines §3.1)', () => {
  it('отклонённый элемент: повторный импорт связывает инженер, неприменимость — только руководитель', async () => {
    const b = await importAndProcess(
      s.eng1,
      s.stageA,
      'партия.zip',
      buildZip([
        { name: 'D1.pdf', data: fakePdf('d1') },
        { name: 'D2.pdf', data: Buffer.from('повреждён') },
        { name: 'D3.pdf', data: Buffer.from('тоже повреждён') },
      ]),
    );
    expect(b.status).toBe('completed_with_errors');
    expect(b.counts.unresolved).toBe(2);
    const d2 = b.items.find((i: { memberPath: string }) => i.memberPath === 'D2.pdf');
    const d3 = b.items.find((i: { memberPath: string }) => i.memberPath === 'D3.pdf');

    const fixed = await importAndProcess(s.eng1, s.stageA, 'D2.pdf', fakePdf('d2 исправлен'));
    const etag = (item: { id: string; rowVersion: number }) => ({ 'If-Match': `"${item.id}:${item.rowVersion}"`, ...idem() });
    const r1 = await s.eng1.post(`/import-items/${d2.id}/resolve`, { resolution: 'reimported', resolvedByItemId: fixed.items[0].id }, { headers: etag(d2) });
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.resolution).toBe('reimported');

    const denied = await s.eng1.post(`/import-items/${d3.id}/resolve`, { resolution: 'not_applicable', reason: 'черновик, не документ заказчика' }, { headers: etag(d3) });
    expect(denied.status).toBe(403);
    const evBefore = (await events(s.stageA)).length;
    const ok = await s.manager.post(`/import-items/${d3.id}/resolve`, { resolution: 'not_applicable', reason: 'черновик, не документ заказчика' }, { headers: etag(d3) });
    expect(ok.status).toBe(200);
    expect(ok.body.resolutionDecisionId).toBeTruthy();
    expect((await events(s.stageA)).length).toBe(evBefore); // решение событий барьера не порождает

    const again = await s.manager.post(`/import-items/${d3.id}/resolve`, { resolution: 'not_applicable', reason: 'повтор решения' }, { headers: etag(ok.body) });
    expect(again.status).toBe(409);
    const after = (await s.eng1.get(`/imports/${b.id}`)).body;
    expect(after.counts.unresolved).toBe(0);
    expect(after.items.find((i: { id: string }) => i.id === d3.id).status).toBe('rejected'); // отказ остаётся в истории
  });

  it('зарегистрированному элементу исход не задаётся; решение в обход API — только руководитель тендера', async () => {
    const b = await importAndProcess(s.eng1, s.stageA, 'D9.pdf', fakePdf('d9'));
    const item = b.items[0];
    const r = await s.manager.post(`/import-items/${item.id}/resolve`, { resolution: 'not_applicable', reason: 'проверка запрета' }, { headers: { 'If-Match': `"${item.id}:${item.rowVersion}"`, ...idem() } });
    expect(r.status).toBe(409);
    await expect(
      db.pool.query(
        "INSERT INTO decision (tender_id, subject_type, subject_id, decision_type, statement, rationale, decided_by) VALUES ($1, 'import_item', $2, 'import_item_disposition', 'x', 'x', $3)",
        [s.tenderA, item.id, s.ids.eng1],
      ),
    ).rejects.toThrow(/только руководитель/);
    await expect(db.pool.query("UPDATE import_item SET status = 'pending' WHERE id = $1", [item.id])).rejects.toThrow(/frozen-after/);
  });
});
