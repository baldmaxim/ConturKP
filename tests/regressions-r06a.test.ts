// Регрессии по ревью 06a-1 (docs/reviews/06a-review-1.md): R06a-01 — строка доступа создателя договора.
// Прямые операции под ролью приложения: вторая линия БД (миграция 0013) держит инвариант без кода API.
// Проверки 4 и 5 падают на схеме передачи 0778fa0 (только миграция 0012): там такие строки записывались.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator } from './contractFixtures.ts';
import { buildScenario, createTestDb, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
// Договор, созданный инженером 1 прямо в БД: строк создателя у него ещё нет.
let own: string;

const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

const grant = (o: { contractId: string | null; userId: string; capability: string; source: 'creator' | 'admin'; grantedBy: string }) =>
  code(
    db.pool.query('INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by) VALUES ($1, $2, $3, $4, $5)', [
      o.contractId,
      o.userId,
      o.capability,
      o.source,
      o.grantedBy,
    ]),
  );

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, testConfig());
  s = await buildScenario(db, app);
  own = (await db.pool.query<{ id: string }>("INSERT INTO contract (number, title, created_by) VALUES ('R06a-1', 'Договор инженера 1', $1) RETURNING id", [s.ids.eng1]))
    .rows[0]!.id;
});
afterAll(async () => {
  await db.drop();
});

describe('R06a-01: выдача создателя — только чтение и ведение по своему договору', () => {
  it('1: настоящий создатель получает contract.read с source = creator', async () => {
    expect(await grant({ contractId: own, userId: s.ids.eng1, capability: 'contract.read', source: 'creator', grantedBy: s.ids.eng1 })).toBe('ok');
  });

  it('2: настоящий создатель получает contract.manage с source = creator', async () => {
    expect(await grant({ contractId: own, userId: s.ids.eng1, capability: 'contract.manage', source: 'creator', grantedBy: s.ids.eng1 })).toBe('ok');
  });

  it('3: другой пользователь не получает выдачу создателя чужого договора', async () => {
    expect(await grant({ contractId: own, userId: s.ids.eng2, capability: 'contract.read', source: 'creator', grantedBy: s.ids.eng2 })).toBe('23503');
  });

  it('4: contract.create не бывает правом создателя — без договора строка source = creator отклоняется', async () => {
    expect(await grant({ contractId: null, userId: s.ids.eng1, capability: 'contract.create', source: 'creator', grantedBy: s.ids.eng1 })).toBe('23514');
    const rows = await db.pool.query("SELECT 1 FROM contract_access WHERE capability = 'contract.create' AND source = 'creator'");
    expect(rows.rowCount).toBe(0);
  });

  it('5: contract.link не выдаётся создателю — только явной выдачей', async () => {
    expect(await grant({ contractId: own, userId: s.ids.eng1, capability: 'contract.link', source: 'creator', grantedBy: s.ids.eng1 })).toBe('23514');
    expect(await grant({ contractId: own, userId: s.ids.eng1, capability: 'contract.link', source: 'admin', grantedBy: s.ids.admin })).toBe('ok');
  });

  it('6: глобальная contract.create — административной выдачей', async () => {
    expect(await grant({ contractId: null, userId: s.ids.eng2, capability: 'contract.create', source: 'admin', grantedBy: s.ids.admin })).toBe('ok');
  });

  it('7: создание договора через API по-прежнему выдаёт создателю ровно чтение и ведение', async () => {
    await grantCreator(s.admin, s.ids.manager);
    const id = await createContract(s.manager, 'R06a-2');
    const rows = await db.pool.query<{ user_id: string; capability: string; source: string }>(
      'SELECT user_id, capability, source FROM contract_access WHERE contract_id = $1 AND revoked_at IS NULL ORDER BY capability',
      [id],
    );
    expect(rows.rows).toEqual([
      { user_id: s.ids.manager, capability: 'contract.manage', source: 'creator' },
      { user_id: s.ids.manager, capability: 'contract.read', source: 'creator' },
    ]);
    expect((await s.manager.get(`/contracts/${id}`)).body.capabilities).toEqual(['contract.read', 'contract.manage']);
  });
});
