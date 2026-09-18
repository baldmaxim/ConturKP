// npm run db:seed-demo [-- --password-stdin] — синтетические демо-данные для разработки.
// Только KONTUR_ENV=development|test. Все имена и тендеры вымышлены (fixtures без реальных данных).
// Один пароль для всех демо-пользователей вводится скрыто; повторный запуск пропускает существующее.
import type { MemberRole, Role } from '../packages/core/src/index.ts';
import { hashPassword, passwordProblem } from '../packages/core/src/index.ts';
import { createPool, withTransaction, writeAudit } from '../packages/db/src/index.ts';
import { fail, readPassword } from './cli.ts';

const env = process.env.KONTUR_ENV;
if (env !== 'development' && env !== 'test') fail('демо-данные только при KONTUR_ENV=development или test', 2);
const url = process.env.DATABASE_URL;
if (!url) fail('нужен DATABASE_URL', 2);

const USERS: { login: string; name: string; roles: Role[] }[] = [
  { login: 'demo.admin', name: 'Демо Администратор', roles: ['admin', 'manager'] },
  { login: 'demo.manager', name: 'Демо Руководитель', roles: ['manager'] },
  { login: 'demo.eng1', name: 'Демо Инженер 1', roles: ['engineer'] },
  { login: 'demo.eng2', name: 'Демо Инженер 2', roles: ['engineer'] },
  { login: 'demo.eng3', name: 'Демо Инженер 3', roles: ['engineer'] },
];

const TENDERS: { code: string; title: string; customer: string; object: string; members: [string, MemberRole][]; stages: string[] }[] = [
  {
    code: 'DEMO-001',
    title: 'Монолитный каркас жилого дома (демо)',
    customer: 'ООО «Демо-Заказчик»',
    object: 'Жилой дом, корпус 1 (вымышленный)',
    members: [['demo.manager', 'manager'], ['demo.eng1', 'engineer'], ['demo.eng2', 'engineer']],
    stages: ['Первичное КП', 'Уточнение после переговоров'],
  },
  {
    code: 'DEMO-002',
    title: 'Инженерные сети склада (демо)',
    customer: 'АО «Пример»',
    object: 'Складской комплекс (вымышленный)',
    members: [['demo.manager', 'manager'], ['demo.eng3', 'engineer']],
    stages: ['Первичное КП'],
  },
];

const password = await readPassword('Пароль для демо-пользователей (не короче 12 символов)');
const problem = passwordProblem(password);
if (problem) fail(problem, 2);
const hash = await hashPassword(password);
const pool = createPool(url!, 1);
try {
  await withTransaction(pool, async (db) => {
    const ids = new Map<string, string>();
    for (const u of USERS) {
      const found = await db.query<{ id: string }>('SELECT id FROM app_user WHERE login = $1', [u.login]);
      let id = found.rows[0]?.id;
      if (!id) {
        const r = await db.query<{ id: string }>(
          "INSERT INTO app_user (kind, login, display_name, password_hash) VALUES ('human', $1, $2, $3) RETURNING id",
          [u.login, u.name, hash],
        );
        id = r.rows[0]!.id;
        for (const role of u.roles) await db.query('INSERT INTO user_role (user_id, role) VALUES ($1, $2)', [id, role]);
        console.log(`пользователь ${u.login}: ${u.roles.join(', ')}`);
      }
      ids.set(u.login, id);
    }
    const admin = ids.get('demo.admin')!;
    for (const t of TENDERS) {
      const exists = await db.query('SELECT 1 FROM tender WHERE code = $1', [t.code]);
      if (exists.rowCount) continue;
      const r = await db.query<{ id: string }>(
        'INSERT INTO tender (code, title, customer_name, object_name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [t.code, t.title, t.customer, t.object, admin],
      );
      const tenderId = r.rows[0]!.id;
      for (const [login, role] of t.members) {
        await db.query('INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)', [
          tenderId,
          ids.get(login),
          role,
          admin,
        ]);
      }
      for (const [i, title] of t.stages.entries()) {
        await db.query(
          "INSERT INTO tender_stage (tender_id, seq, title, submission_deadline, created_by) VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)",
          [tenderId, i + 1, title, 14 * (i + 1), admin],
        );
      }
      await writeAudit(db, {
        actorUserId: null,
        principalKind: 'system',
        action: 'demo.seed',
        entityType: 'tender',
        entityId: tenderId,
        tenderId,
        outcome: 'allowed',
        details: { code: t.code },
      });
      console.log(`тендер ${t.code}: участников ${t.members.length}, этапов ${t.stages.length}`);
    }
  });
  console.log('демо-данные готовы');
} finally {
  await pool.end();
}
