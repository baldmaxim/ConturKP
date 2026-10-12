// Этап 15a (S15-14, D-036): сохранённый ответ команды привязан к правам, с которыми он построен. После отзыва права повтор
// по тому же ключу идемпотентности не возвращает сохранённое тело: `409 replay_unavailable`, второй записи нет. Сценарий —
// команда этапа 08 `assumption.create`, названная в Review 15-2: допущение по требованию, формулировка которого закрыта
// вместе с договором-основанием (замыкание закрытости, R08-02). Данные поддельные.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessFingerprint, loadAccessContext } from '../packages/db/src/index.ts';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { createMailbox, setMailAccess } from './mailFixtures.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';

const SECRET = 'КЛЮЧ-15A-90417';
const CLARIFIES = `Особое условие: бетон фасадных колонн по шифру ${SECRET}, сведения закрытые.`;
const FULL = ['contract.read', 'contract.link', 'contract.manage'];

let db: ITestDb;
let st: IStage08;
let contract: string;
let requirement: string;
const config = testConfig();

const body = () => ({ statement: `Допускаем ${SECRET} до выхода РД`, requirementId: requirement });
const path = () => `/stages/${st.s.stageA}/assumptions`;
const assumptions = async (): Promise<number> => Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM assumption WHERE stage_id = $1', [st.s.stageA])).rows[0]!.n);
const stored = async (key: Record<string, string>) =>
  (await db.pool.query<{ request_hash: string; response_status: number; response_body: { body?: unknown; etag?: string; access?: string } }>(
    'SELECT request_hash, response_status, response_body FROM idempotency_record WHERE principal_id = $1 AND key = $2',
    [st.s.ids.manager, key['Idempotency-Key']],
  )).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
  const { s } = st;
  await grantCreator(s.admin, s.ids.manager);
  contract = await createContract(s.manager, 'Д-15A-1');
  await setAccess(s.admin, contract, s.ids.manager, FULL);
  const rev = (await uploadMain(s.manager, contract)).revisionId;
  const run = await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [CLARIFIES] }] });
  const closedFragment = await fragmentIdOf(db.pool, run, CLARIFIES);
  await linkContract(s.manager, contract, s.tenderA);
  await setWorkingSet(s.manager, s.stageA, [st.docRev, rev], true);
  const scope = await fixScope(s.manager, s.stageA);
  const registry = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'ТЗ и договор' }, { headers: idem() });
  expect(registry.status, registry.text).toBe(201);
  // Требование: открытое основание из ТЗ и закрытое уточнение из договора; секрет — в формулировке.
  const candidate = await propose(s.manager, registry.body.id as string, `Фасадные колонны — бетон по шифру ${SECRET}`, [...supports(st.frag.facade), { fragmentId: closedFragment, role: 'clarifies' }]);
  const confirmed = await confirm(s.manager, candidate.id);
  expect(confirmed.status, confirmed.text).toBe(200);
  requirement = confirmed.body.requirementId as string;
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

describe('повтор команды и права (S15-14)', () => {
  it('без изменения прав повтор отдаёт сохранённый ответ; запись хранит отпечаток прав (контроль)', async () => {
    const key = idem();
    const a = await st.s.manager.post(path(), body(), { headers: key });
    expect(a.status, a.text).toBe(201);
    expect(JSON.stringify(a.body)).toContain(SECRET);
    const before = await assumptions();
    const b = await st.s.manager.post(path(), body(), { headers: key });
    expect(b.status, b.text).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    expect(b.headers.etag).toBe(a.headers.etag);
    expect(await assumptions()).toBe(before);
    const ctx = (await loadAccessContext(db.pool, st.s.ids.manager, 'test'))!;
    expect((await stored(key))!.response_body.access).toBe(accessFingerprint(ctx));
  });

  it('после отзыва доступа к договору повтор не возвращает закрытую формулировку: 409 replay_unavailable, второй записи нет', async () => {
    const key = idem();
    const a = await st.s.manager.post(path(), body(), { headers: key });
    expect(a.status, a.text).toBe(201);
    const id = a.body.id as string;
    const before = await assumptions();
    await setAccess(st.s.admin, contract, st.s.ids.manager, []);
    try {
      // Чтение уже скрывает формулировку: требование закрыто вместе с договором.
      const card = await st.s.manager.get(`/assumptions/${id}`);
      expect(JSON.stringify(card.body)).not.toContain(SECRET);
      const replay = await st.s.manager.post(path(), body(), { headers: key });
      expect(replay.status, replay.text).toBe(409);
      expect(replay.body).toMatchObject({ code: 'STATE_CONFLICT', current: { reason: 'replay_unavailable' } });
      expect(replay.headers['idempotent-replayed']).toBeUndefined();
      expect(JSON.stringify(replay.body)).not.toContain(SECRET);
      expect(await assumptions()).toBe(before);
    } finally {
      await setAccess(st.s.admin, contract, st.s.ids.manager, FULL);
    }
    // Право возвращено — отпечаток прежний, сохранённый ответ снова доступен; записи по-прежнему одна.
    const again = await st.s.manager.post(path(), body(), { headers: key });
    expect(again.status, again.text).toBe(201);
    expect(again.body).toEqual(a.body);
    expect(await assumptions()).toBe(before);
  });

  it('любое изменение прав, в том числе расширение, делает сохранённый ответ недоступным', async () => {
    const key = idem();
    const a = await st.s.manager.post(path(), body(), { headers: key });
    expect(a.status, a.text).toBe(201);
    const before = await assumptions();
    const mailbox = await createMailbox(st.s.admin, 'replay-15a@contractor.example.test', 'Ящик для проверки повтора');
    await setMailAccess(st.s.admin, mailbox, st.s.ids.manager, ['mail.read']);
    const grown = await st.s.manager.post(path(), body(), { headers: key });
    expect(grown.status, grown.text).toBe(409);
    expect(grown.body.current).toMatchObject({ reason: 'replay_unavailable' });
    await setMailAccess(st.s.admin, mailbox, st.s.ids.manager, []);
    const back = await st.s.manager.post(path(), body(), { headers: key });
    expect(back.status, back.text).toBe(201);
    expect(back.headers['idempotent-replayed']).toBe('true');
    expect(await assumptions()).toBe(before);
  });

  it('запись, созданная до привязки к правам (без отпечатка), сохранённое тело не отдаёт', async () => {
    const key = idem();
    const a = await st.s.manager.post(path(), body(), { headers: key });
    expect(a.status, a.text).toBe(201);
    const fresh = (await stored(key))!;
    // Запись прежнего вида: тот же запрос, тело ответа без отпечатка прав.
    const legacyKey = { 'Idempotency-Key': `legacy-${randomBytes(8).toString('hex')}` };
    await db.pool.query(
      `INSERT INTO idempotency_record (principal_id, key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [st.s.ids.manager, legacyKey['Idempotency-Key'], fresh.request_hash, 201, JSON.stringify({ body: fresh.response_body.body, etag: fresh.response_body.etag })],
    );
    const before = await assumptions();
    const replay = await st.s.manager.post(path(), body(), { headers: legacyKey });
    expect(replay.status, replay.text).toBe(409);
    expect(replay.body.current).toMatchObject({ reason: 'replay_unavailable' });
    expect(JSON.stringify(replay.body)).not.toContain(SECRET);
    expect(await assumptions()).toBe(before);
  });

  it('ключ с другим запросом — 422; чужой пользователь по тому же ключу чужого ответа не получает; снятая роль — отказ authorize', async () => {
    const key = idem();
    const a = await st.s.manager.post(path(), body(), { headers: key });
    expect(a.status, a.text).toBe(201);
    const other = await st.s.manager.post(path(), { statement: 'Другое допущение' }, { headers: key });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Инженер 3 — не участник тендера A: его запрос с тем же ключом до записи руководителя не доходит.
    const stranger = await st.s.eng3.post(path(), body(), { headers: key });
    expect([403, 404]).toContain(stranger.status);
    expect(JSON.stringify(stranger.body)).not.toContain(SECRET);
  });
});

describe('отпечаток прав', () => {
  const ctx = (o: Partial<Parameters<typeof accessFingerprint>[0]> = {}): Parameters<typeof accessFingerprint>[0] => ({
    principal: { userId: 'u', kind: 'human', login: 'u', displayName: 'U' },
    roles: new Set(['engineer']),
    memberships: new Map([['t1', 'engineer'], ['t2', 'engineer']]),
    contractGrants: new Map([['c1', new Set(['contract.read', 'contract.link'])]]),
    contractCreateGranted: false,
    mailGrants: new Map([['m1', new Set(['mail.read', 'mail.link'])]]),
    requestId: 'r1',
    ...o,
  } as Parameters<typeof accessFingerprint>[0]);

  it('не зависит от порядка, личности и номера запроса; меняется от каждого вида права', () => {
    const base = accessFingerprint(ctx());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(accessFingerprint(ctx({ requestId: 'r2', memberships: new Map([['t2', 'engineer'], ['t1', 'engineer']]), contractGrants: new Map([['c1', new Set(['contract.link', 'contract.read'])]]), mailGrants: new Map([['m1', new Set(['mail.link', 'mail.read'])]]) } as never))).toBe(base);
    const changed = [
      ctx({ roles: new Set(['engineer', 'manager']) } as never),
      ctx({ roles: new Set() } as never),
      ctx({ memberships: new Map([['t1', 'engineer']]) } as never),
      ctx({ memberships: new Map([['t1', 'manager'], ['t2', 'engineer']]) } as never),
      ctx({ contractGrants: new Map([['c1', new Set(['contract.link'])]]) } as never),
      ctx({ contractGrants: new Map() } as never),
      ctx({ contractCreateGranted: true }),
      ctx({ mailGrants: new Map([['m1', new Set(['mail.link'])]]) } as never),
      ctx({ mailGrants: new Map([['m1', new Set(['mail.read', 'mail.link'])], ['m2', new Set(['mail.read'])]]) } as never),
    ].map(accessFingerprint);
    for (const f of changed) expect(f).not.toBe(base);
    expect(new Set(changed).size).toBe(changed.length);
  });
});
