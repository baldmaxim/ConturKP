import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { globalCapabilities,tenderCapabilities } from '../packages/core/src/index.ts';
import { loadAccessContext } from '../packages/db/src/index.ts';
import { buildScenario,createTestDb,idem,makeApp,TestClient,PASSWORD,type IScenario,type ITestDb } from './helpers.ts';
let db:ITestDb;let s:IScenario;let app:ReturnType<typeof makeApp>;let role:Role;let user:TestClient;let userId:string;let originalAdmin:Role;let originalManager:Role;
type Role={id:string;code:string;name:string;description:string;baseRole:'engineer'|'manager'|'admin';permissions:string[];builtIn:boolean;status:'active'|'disabled';rowVersion:number;users:number};
const list=async(client=s.admin):Promise<Role[]>=>{const r=await client.get('/admin/roles');expect(r.status,r.text).toBe(200);return r.body.items;};
const body=(r:Role)=>({name:r.name,description:r.description,baseRole:r.baseRole,permissions:r.permissions,status:r.status});
const change=async(r:Role,patch:Partial<ReturnType<typeof body>>,client=s.admin)=>client.patch('/admin/roles/'+r.id,{...body(r),...patch},{headers:{'If-Match':'"'+r.id+':'+r.rowVersion+'"'}});
const fresh=async(id:string,client=s.admin)=>(await list(client)).find(r=>r.id===id)!;
beforeAll(async()=>{db=await createTestDb();app=makeApp(db);s=await buildScenario(db,app);const roles=await list();originalAdmin=roles.find(r=>r.code==='admin')!;originalManager=roles.find(r=>r.code==='manager')!;},180_000);
afterAll(async()=>{await db?.drop();});
describe('собственные роли и разрешения',()=>{
 it('начальные роли сохранены, руководитель видит офис без административного доступа',async()=>{
  expect((await list()).map(r=>r.code).sort()).toEqual(['admin','engineer','manager']);
  expect(originalManager.permissions).toContain('office.read');expect(originalManager.permissions).not.toContain('admin.roles');
  expect((await s.manager.get('/admin/office')).status).toBe(200);
  expect((await s.manager.get('/admin/office/diagnostics')).status).toBe(200);
  for(const path of ['/admin/roles','/admin/users','/admin/operations','/admin/audit-events'])expect((await s.manager.get(path)).status,path).toBe(403);
  expect((await s.eng1.get('/admin/office')).status).toBe(403);
 });
 it('создаёт собственную роль на основе инженера и назначает её пользователю',async()=>{
  const r=await s.admin.post('/admin/roles',{name:'Наблюдатель офиса',description:'Только офис',baseRole:'engineer',permissions:['office.read']},{headers:idem()});
  expect(r.status,r.text).toBe(201);role=r.body;expect(role).toMatchObject({builtIn:false,baseRole:'engineer',permissions:['office.read'],users:0});
  const u=await s.admin.post('/admin/users',{login:'role-viewer',displayName:'Наблюдатель',password:PASSWORD,roles:[role.code]},{headers:idem()});
  expect(u.status,u.text).toBe(201);userId=u.body.id;expect(u.body).toMatchObject({roles:[role.code],roleNames:[role.name]});
  user=new TestClient(app);expect((await user.login('role-viewer')).status).toBe(200);
  const me=await user.get('/me');expect(me.body).toMatchObject({roles:['engineer'],assignedRoles:[role.code],capabilities:['office.read']});
  expect((await user.get('/admin/office')).status).toBe(200);expect((await user.get('/tenders')).body.items).toEqual([]);
  expect((await user.get('/admin/roles')).status).toBe(403);
 });
 it('назначение не обходит ограничения собственной роли',async()=>{
  const t=await s.admin.get('/tenders/'+s.tenderB);
  const assigned=await s.admin.put('/tenders/'+s.tenderB+'/members/'+userId,{memberRole:'engineer'},{headers:{'If-Match':t.headers.etag}});
  expect(assigned.status,assigned.text).toBe(200);
  expect((await user.get('/stages/'+s.stageB)).status).toBe(404);
  const ctx=(await loadAccessContext(db.pool,userId,'role-test'))!;
  expect(tenderCapabilities(ctx.roles,'engineer')).toEqual([]);
  const sql=(await db.pool.query<{caps:string[]}>('SELECT tender_capabilities($1,$2) AS caps',[userId,s.tenderB])).rows[0]!.caps;
  expect(sql).toEqual([]);
 });
 it('изменение разрешения применяется сразу в прежней сессии и меняет accessVersion',async()=>{
  const before=(await user.get('/me')).body.accessVersion;
  const updated=await change(await fresh(role.id),{permissions:[]});expect(updated.status,updated.text).toBe(200);
  expect((await user.get('/admin/office')).status).toBe(403);
  const me=await user.get('/me');expect(me.body.capabilities).toEqual([]);expect(me.body.accessVersion).not.toBe(before);
  const back=await change(updated.body,{permissions:['office.read','tender.read.all','contract.read.all','mail.read.all']});expect(back.status,back.text).toBe(200);role=back.body;
  expect(role.permissions).toEqual(expect.arrayContaining(['office.read','tender.read','contract.read','mail.read']));
  expect((await user.get('/admin/office')).status).toBe(200);
  expect((await user.get('/tenders')).body.items).toHaveLength(2);
  expect((await user.get('/stages/'+s.stageA)).status).toBe(200);
  expect((await user.post('/tenders/'+s.tenderA+'/stages',{title:'Запрещено'},{headers:idem()})).status).toBe(403);
 });
 it('права нескольких ролей объединяются и отображаются по именам',async()=>{
  const add=await s.admin.post('/admin/roles',{name:'Инженер проекта',baseRole:'engineer',permissions:['tender.read','stage.write']},{headers:idem()});expect(add.status,add.text).toBe(201);
  const u=(await s.admin.get('/admin/users')).body.items.find((x:{id:string})=>x.id===userId);
  const assign=await s.admin.patch('/admin/users/'+userId,{roles:[role.code,add.body.code]},{headers:{'If-Match':'"'+userId+':'+u.rowVersion+'"'}});expect(assign.status,assign.text).toBe(200);
  const ctx=(await loadAccessContext(db.pool,userId,'merged'))!;
  expect(tenderCapabilities(ctx.roles,'engineer')).toEqual(expect.arrayContaining(['tender.read','stage.write','audit.read']));
  expect((await user.get('/me')).body.assignedRoles).toEqual(expect.arrayContaining([role.code,add.body.code]));
  expect(assign.body.roleNames).toEqual(expect.arrayContaining(['Наблюдатель офиса','Инженер проекта']));
 });
 it('отключение роли отзывает только её права без удаления назначений',async()=>{
  const off=await change(await fresh(role.id),{status:'disabled'});expect(off.status,off.text).toBe(200);
  expect((await user.get('/admin/office')).status).toBe(403);
  expect((await user.get('/stages/'+s.stageA)).status).toBe(404);
  expect((await user.get('/stages/'+s.stageB)).status).toBe(200);
  expect((await user.get('/me')).body.assignedRoles).toContain(role.code);
  const back=await change(off.body,{status:'active'});expect(back.status,back.text).toBe(200);
  expect((await user.get('/admin/office')).status).toBe(200);
 });
 it('системную роль руководителя также можно настроить, не открывая администрирование',async()=>{
  const r=await change(await fresh(originalManager.id),{permissions:originalManager.permissions.filter(p=>p!=='office.read'&&p!=='tender.read.all')});expect(r.status,r.text).toBe(200);
  try{expect((await s.manager.get('/admin/office')).status).toBe(403);expect((await s.manager.get('/admin/users')).status).toBe(403);}
  finally{const back=await change(r.body,{permissions:originalManager.permissions});expect(back.status,back.text).toBe(200);}
  expect((await s.manager.get('/admin/office')).status).toBe(200);
 });
 it('защищает системную основу, версию и неизвестные разрешения',async()=>{
  expect((await change(await fresh(originalManager.id),{baseRole:'admin'})).status).toBe(409);
  const current=await fresh(role.id);const updated=await change(current,{description:'Изменено'});expect(updated.status).toBe(200);
  expect((await change(current,{name:'Устаревшая правка'})).status).toBe(412);
  expect((await change(updated.body,{permissions:['unknown.permission']})).status).toBe(400);
  const spoof=await s.eng1.post('/admin/roles',{name:'Подмена',baseRole:'admin',permissions:originalAdmin.permissions},{headers:{...idem(),'X-Role':'admin'}});expect(spoof.status).toBe(403);
 });
 it('не назначает неизвестную или отключённую роль',async()=>{
  const bad=await s.admin.post('/admin/users',{login:'bad-role',displayName:'Не создан',password:PASSWORD,roles:['missing_role']},{headers:idem()});expect(bad.status).toBe(409);
  const off=await change(await fresh(role.id),{status:'disabled'});expect(off.status).toBe(200);
  try{const denied=await s.admin.post('/admin/users',{login:'off-role',displayName:'Не создан',password:PASSWORD,roles:[role.code]},{headers:idem()});expect(denied.status).toBe(409);}
  finally{expect((await change(off.body,{status:'active'})).status).toBe(200);}
 });
 it('нельзя удалить последнее право управления пользователями и ролями',async()=>{
  const admin=await fresh(originalAdmin.id);
  expect((await change(admin,{permissions:admin.permissions.filter(p=>p!=='admin.roles')})).status).toBe(409);
  expect((await change(admin,{status:'disabled'})).status).toBe(409);
  const u=(await s.admin.get('/admin/users')).body.items.find((x:{id:string})=>x.id===s.ids.admin);
  expect((await s.admin.patch('/admin/users/'+s.ids.admin,{roles:[role.code]},{headers:{'If-Match':'"'+s.ids.admin+':'+u.rowVersion+'"'}})).status).toBe(409);
  expect((await s.admin.get('/admin/roles')).status).toBe(200);
 });
 it('параллельные изменения ролей не оставляют портал без администратора',async()=>{
  const r=await s.admin.post('/admin/roles',{name:'Резервный администратор',baseRole:'admin',permissions:originalAdmin.permissions},{headers:idem()});expect(r.status,r.text).toBe(201);
  const u=await s.admin.post('/admin/users',{login:'backup-role-admin',displayName:'Резервный',password:PASSWORD,roles:[r.body.code]},{headers:idem()});expect(u.status,u.text).toBe(201);
  const second=new TestClient(app);expect((await second.login('backup-role-admin')).status).toBe(200);
  const a=await fresh(originalAdmin.id);const b=r.body as Role;
  const results=await Promise.all([change(a,{status:'disabled'}),change(b,{status:'disabled'},second)]);
  expect(results.map(x=>x.status).sort()).toEqual([200,409]);
  const survivor=results[0]!.status===200?second:s.admin;
  for(const original of [a,b]){const now=await fresh(original.id,survivor);if(now.status==='disabled')expect((await change(now,{status:'active'},survivor)).status).toBe(200);}
  expect((await s.admin.get('/admin/roles')).status).toBe(200);
 });
 it('административная основа сама не даёт прав сверх выбранных разрешений',async()=>{
  const r=await s.admin.post('/admin/roles',{name:'Контролёр просмотра',baseRole:'admin',permissions:['office.read','tender.read.all','contract.read.all','mail.read.all']},{headers:idem()});expect(r.status,r.text).toBe(201);
  const u=await s.admin.post('/admin/users',{login:'read-only-admin-base',displayName:'Контролёр',password:PASSWORD,roles:[r.body.code]},{headers:idem()});expect(u.status,u.text).toBe(201);
  const viewer=new TestClient(app);expect((await viewer.login('read-only-admin-base')).status).toBe(200);
  expect((await viewer.get('/admin/users')).status).toBe(403);expect((await viewer.get('/admin/roles')).status).toBe(403);expect((await viewer.get('/admin/office')).status).toBe(200);
  expect((await viewer.get('/stages/'+s.stageA)).status).toBe(200);
  const token=await viewer.post('/me/api-tokens',{name:'Тест чтения',clientKind:'codex',propose:false,lifetimeDays:7},{headers:idem()});expect(token.status,token.text).toBe(201);
 });
 it('журнал фиксирует создание и изменение роли с автором',async()=>{
  const events=(await db.pool.query<{action:string;actor_user_id:string}>('SELECT action,actor_user_id FROM audit_event WHERE entity_id=$1 AND outcome=\'allowed\' ORDER BY seq',[role.id])).rows;
  expect(events.map(e=>e.action)).toEqual(expect.arrayContaining(['admin.role.create','admin.role.update']));
  expect(events.every(e=>e.actor_user_id===s.ids.admin)).toBe(true);
  const ctx=(await loadAccessContext(db.pool,userId,'final'))!;expect(globalCapabilities(ctx.roles)).not.toContain('admin.roles');
 });
});
