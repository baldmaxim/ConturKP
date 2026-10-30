import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestDb,buildScenario,makeApp,TestClient,idem,PASSWORD,type ITestDb,type IScenario} from './helpers.ts';
let db:ITestDb;let s:IScenario;let user:TestClient;let uid:string;let role:any;
const change=async(permissions:string[])=>{const r=await s.admin.patch('/admin/roles/'+role.id,{name:role.name,description:role.description,baseRole:role.baseRole,status:'active',permissions},{headers:{'If-Match':'"'+role.id+':'+role.rowVersion+'"'}});expect(r.status,r.text).toBe(200);role=r.body;};
beforeAll(async()=>{db=await createTestDb();const app=makeApp(db);s=await buildScenario(db,app);const r=await s.admin.post('/admin/roles',{name:'Общая история по разрешению',baseRole:'engineer',permissions:['office.read']},{headers:idem()});expect(r.status,r.text).toBe(201);role=r.body;const u=await s.admin.post('/admin/users',{login:'history-role-test',displayName:'История',roles:[role.code],password:PASSWORD},{headers:idem()});expect(u.status,u.text).toBe(201);uid=u.body.id;user=new TestClient(app);expect((await user.login('history-role-test')).status).toBe(200);},180_000);
afterAll(async()=>{await db?.drop();});
describe('настройка доступа общей истории',()=>{
 it('офис без истории не открывает общие материалы или их изменение',async()=>{
  expect((await user.get('/history')).status).toBe(403);expect((await user.get('/history/members')).status).toBe(403);expect((await user.post('/history/tasks',{title:'Запрещено'},{headers:idem()})).status).toBe(403);
  expect((await db.pool.query('SELECT history_actor_can_write($1,NULL) AS ok',[uid])).rows[0].ok).toBe(false);
 });
 it('разрешение чтения открывает историю без прав изменения',async()=>{
  await change(['office.read','history.read']);expect((await user.get('/history')).status).toBe(200);expect((await user.post('/history/tasks',{title:'Запрещено'},{headers:idem()})).status).toBe(403);
 });
 it('ведение общих материалов включается отдельно и совпадает с охранником БД',async()=>{
  await change(['office.read','history.write']);expect(role.permissions).toContain('history.read');
  const task=await user.post('/history/tasks',{title:'Общая задача'},{headers:idem()});expect(task.status,task.text).toBe(201);
  expect((await db.pool.query('SELECT history_actor_can_write($1,NULL) AS ok',[uid])).rows[0].ok).toBe(true);
  expect((await db.pool.query('SELECT history_actor_can_manage($1,NULL) AS ok',[uid])).rows[0].ok).toBe(false);
 });
 it('отзыв права действует в прежней сессии и при прямой записи в БД',async()=>{
  await change(['office.read','history.read']);expect((await user.get('/history')).status).toBe(200);expect((await user.post('/history/tasks',{title:'Запрещено'},{headers:idem()})).status).toBe(403);
  await expect(db.pool.query('INSERT INTO tender_history_task(title,created_by,updated_by) VALUES($1,$2,$2)',['Запрещено',uid])).rejects.toMatchObject({code:'42501'});
 });
});
