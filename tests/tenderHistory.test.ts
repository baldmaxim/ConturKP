import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { prepareLegacyHistory,readLegacyHistory } from '../packages/core/src/tenderHistory.ts';
import { createTestDb,buildScenario,makeApp,idem,type IScenario,type ITestDb } from './helpers.ts';

const folder='330. Пример';
const report=(title='Проверить исходные данные',extra:Record<string,unknown>={})=>{
  const data={
    folders:[{tender:true,tender_id:'folder-a',id:folder}],snapshot:{started_at:'2026-10-23T10:00:00Z',finished_at:'2026-10-23T10:35:00Z',complete:true},
    events:[
      {id:0,event_key:'note-1',tender_id:'folder-a',folder,kind:'note',title,summary:'Обсудить изменение объёмов',at:'2026-10-22T10:00:00Z',source:'Agents/output/chronology.json'},
      {id:'mail-1',tender_id:'folder-a',folder,kind:'mail',title:'Закрытая тема письма',summary:'Секретное содержимое',at:'2026-10-22T09:00:00Z'},
    ],
    files:[
      {p:folder+'/Раздел А/ВОР.xlsx',tender_id:'folder-a',s:10,h:'a'.repeat(64),st:'ok',m:'2026-10-22T10:00:00Z',end:'2026-10-23T10:05:00Z'},
      {p:folder+'/Раздел Б/ВОР.xlsx',tender_id:'folder-a',s:12,h:'b'.repeat(64),st:'ok',end:'2026-10-23T10:06:00Z'},
      {p:folder+'/Thumbs.db',tender_id:'folder-a',s:2,h:'c'.repeat(64),st:'ok',end:'2026-10-23T10:07:00Z'},
    ],...extra,
  };
  return '<!doctype html><script>throw new Error("must never execute")</script><script id="history-data" type="application/json">'+JSON.stringify(data)+'</script>';
};
describe('чтение исторической хронологии',()=>{
  it('читает только JSON, отделяет одноимённые пути, закрывает письма, сохраняет время проверки',()=>{
    const m=prepareLegacyHistory(readLegacyHistory(report()),'folder-a');
    expect(m.records[0]).toMatchObject({key:'note-1',kind:'note',occurredAt:'2026-10-22T10:00:00.000Z'});
    expect(m.records[1]!.restricted).toBe(true);
    expect(m.files.map(f=>f.path)).toEqual(['Раздел А/ВОР.xlsx','Раздел Б/ВОР.xlsx','Thumbs.db']);
    expect(m.files[2]!.technical).toBe(true);
    expect(m.files[0]!.verifiedAt).toBe('2026-10-23T10:05:00.000Z');
  });
  it('числовой ID 0 сохраняет идентичность',()=>{
    const data=readLegacyHistory(report());delete (data.data.events as Record<string,unknown>[])[0]!.event_key;
    expect(prepareLegacyHistory(data,'folder-a').records[0]!.key).toBe('0');
  });
  it('отказывает при чужой папке, выходе за корень и повторном пути',()=>{
    const base=readLegacyHistory(report());
    expect(()=>prepareLegacyHistory(base,'other')).toThrow();
    (base.data.files as Record<string,unknown>[])[0]!.p=folder+'/../outside.xlsx';
    expect(()=>prepareLegacyHistory(base,'folder-a')).toThrow('путь');
    const duplicated=readLegacyHistory(report());(duplicated.data.files as unknown[]).push((duplicated.data.files as unknown[])[0]);
    expect(()=>prepareLegacyHistory(duplicated,'folder-a')).toThrow('Неоднозначный путь');
  });
  it('не принимает противоречие ID и пути, неверный интервал и небезопасную ссылку источника',()=>{
    const source=readLegacyHistory(report());(source.data.events as Record<string,unknown>[])[0]!.folder='999. Другой';
    expect(()=>prepareLegacyHistory(source,'folder-a')).toThrow('противоречит');
    expect(()=>prepareLegacyHistory(readLegacyHistory(report('x',{snapshot:{started_at:'2026-10-24T00:00:00Z',finished_at:'2026-10-23T00:00:00Z'}})),'folder-a')).toThrow('интервал');
    const unsafe=readLegacyHistory(report());(unsafe.data.events as Record<string,unknown>[])[0]!.source='https://untrusted.example/run';
    expect(()=>prepareLegacyHistory(unsafe,'folder-a')).toThrow('путь');
  });
});

let db:ITestDb,s:IScenario;
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db));});
afterAll(async()=>{await db?.drop();});
const upload=(client:IScenario['manager'],tenderId:string,text:string,key=randomUUID())=>client.post(
  '/tenders/'+tenderId+'/history-import?name=history.html&folderId=folder-a&confirmBinding=true',
  Buffer.from(text),{headers:{...idem(), 'Idempotency-Key':key,'Content-Type':'application/octet-stream'}});
describe('хронология и привязка к тендеру',()=>{
  it('импортирует метаданные и не создаёт редакции, отправки или события барьера',async()=>{
    const before=await db.pool.query('SELECT (SELECT count(*) FROM document_revision) AS docs,(SELECT count(*) FROM stage_input_event) AS inputs');
    const r=await upload(s.manager,s.tenderA,report());
    expect(r.status,r.text).toBe(200);expect(r.body).toMatchObject({repeated:false,recordsAdded:2,filesAdded:3});
    const after=await db.pool.query('SELECT (SELECT count(*) FROM document_revision) AS docs,(SELECT count(*) FROM stage_input_event) AS inputs');
    expect(after.rows).toEqual(before.rows);
    const summary=await s.eng1.get('/tenders/'+s.tenderA+'/history-summary');
    expect(summary.status).toBe(200);expect(summary.body.bindings[0]).toMatchObject({files:3,complete:true});
  });
  it('повтор с новым ключом и replay не добавляют строки',async()=>{
    const key=randomUUID(),first=await upload(s.manager,s.tenderA,report(),key),second=await upload(s.manager,s.tenderA,report(),key);
    expect(first.body.repeated).toBe(true);expect(second.status).toBe(200);
    expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_import')).rows[0]!.n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_record')).rows[0]!.n).toBe(2);
  });
  it('изменённая запись получает новую ревизию, старая не исчезает',async()=>{
    const r=await upload(s.manager,s.tenderA,report('Уточнить объёмы'));
    expect(r.status,r.text).toBe(200);expect(r.body.recordsAdded).toBe(1);
    const page=await s.eng1.get('/tenders/'+s.tenderA+'/history');
    expect(page.body.items.filter((r:{recordId:string|null})=>r.recordId)).toHaveLength(1);
    expect(page.body.items.find((r:{title:string})=>r.title==='Уточнить объёмы')).toMatchObject({revision:2});
    expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_record')).rows[0]!.n).toBe(3);
  });
  it('письма не раскрываются ни выдачей, ни поиском',async()=>{
    const list=await s.manager.get('/tenders/'+s.tenderA+'/history');
    expect(JSON.stringify(list.body)).not.toMatch(/Закрытая тема|Секретное содержимое/);
    const search=await s.eng1.get('/tenders/'+s.tenderA+'/history?q='+encodeURIComponent('Секретное'));
    expect(search.body.items).toEqual([]);
  });
  it('файлы имеют отдельные пути; технические скрыты и доступны по фильтру',async()=>{
    const files=await s.eng1.get('/tenders/'+s.tenderA+'/history-files');
    expect(files.body.items).toHaveLength(2);expect(new Set(files.body.items.map((f:{path:string})=>f.path)).size).toBe(2);
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history-files?technical=true')).body.items).toHaveLength(3);
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history-files?q=aaaaaaaa')).body.items).toHaveLength(1);
  });
  it('неназначенный пользователь и инженер не могут импортировать',async()=>{
    expect((await upload(s.eng3,s.tenderA,report())).status).toBe(404);
    expect((await upload(s.eng1,s.tenderA,report())).status).toBe(403);
    expect((await s.eng3.get('/tenders/'+s.tenderA+'/history')).status).toBe(404);
  });
  it('папка не может незаметно перейти к другой карточке',async()=>{
    const r=await upload(s.manager,s.tenderB,report());expect(r.status,r.text).toBe(409);
    expect((await s.eng3.get('/tenders/'+s.tenderB+'/history-summary')).body.bindings).toEqual([]);
  });
  it('задача назначается участнику, закрывается с результатом и имеет историю',async()=>{
    const list=await s.eng1.get('/tenders/'+s.tenderA+'/history');
    const record=list.body.items.find((r:{recordId:string|null})=>r.recordId);
    const created=await s.eng1.post('/tenders/'+s.tenderA+'/history-tasks',{title:'Разобрать изменение',recordId:record.recordId,ownerUserId:s.ids.eng2,dueAt:'2026-10-22T15:00:00Z'},{headers:idem()});
    expect(created.status,created.text).toBe(201);
    expect((await s.eng3.patch('/history-tasks/'+created.body.id,{status:'resolved',ownerUserId:null,dueAt:null,resolution:'Чужая правка'},{headers:{'If-Match':created.headers.etag}})).status).toBe(404);
    const closed=await s.eng1.patch('/history-tasks/'+created.body.id,{status:'resolved',ownerUserId:s.ids.eng2,dueAt:null,resolution:'Проверено: требуется обновить расчёт'},{headers:{'If-Match':created.headers.etag}});
    expect(closed.status,closed.text).toBe(200);
    expect((await db.pool.query('SELECT count(*)::int n FROM tender_history_task_event WHERE task_id=$1',[created.body.id])).rows[0]!.n).toBe(2);
    expect((await s.eng1.patch('/history-tasks/'+created.body.id,{status:'open',ownerUserId:null,dueAt:null,resolution:null},{headers:{'If-Match':created.headers.etag}})).status).toBe(412);
  });
  it('чужие основания, закрытые письма и посторонний ответственный отвергаются',async()=>{
    const restricted=(await db.pool.query("SELECT id FROM tender_history_record WHERE restricted LIMIT 1")).rows[0]!.id;
    for(const [body,status] of [[{title:'x',recordId:restricted},404],[{title:'x',ownerUserId:s.ids.eng3},409]] as const){
      const r=await s.eng1.post('/tenders/'+s.tenderA+'/history-tasks',body,{headers:idem()});expect(r.status,r.text).toBe(status);
    }
  });
  it('ошибочный курсор возвращает 400; ограничение страницы не теряет записи',async()=>{
    expect((await s.eng1.get('/tenders/'+s.tenderA+'/history?cursor=bad')).status).toBe(400);
    const first=await s.eng1.get('/tenders/'+s.tenderA+'/history-files?limit=1');
    const second=await s.eng1.get('/tenders/'+s.tenderA+'/history-files?limit=1&cursor='+first.body.nextCursor);
    expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
  });
  it('артефакты и происхождение неизменяемы; доступ копии сохранён',async()=>{
    await expect(db.pool.query("UPDATE tender_history_record SET title='rewrite'")).rejects.toThrow();
    await expect(db.pool.query("DELETE FROM tender_history_file")).rejects.toThrow();
    const grants=await db.pool.query("SELECT has_table_privilege('kontur_backup','tender_history_record','SELECT') AS can_read");
    expect(grants.rows[0]!.can_read).toBe(true);
  });
  it('общий сервис объединяет доступные тендеры и сохраняет контекст каждого объекта',async()=>{
    const text=report('Отдельная запись второго тендера').replaceAll('folder-a','folder-b').replaceAll(folder,'331. Другой объект');
    const imported=await s.manager.post('/tenders/'+s.tenderB+'/history-import?name=second.html&folderId=folder-b&confirmBinding=true',Buffer.from(text),{headers:{...idem(),'Content-Type':'application/octet-stream'}});
    expect(imported.status,imported.text).toBe(200);
    const created=await s.eng3.post('/tenders/'+s.tenderB+'/history-tasks',{title:'Задача второго тендера',dueAt:'2026-10-22T15:00:00Z'},{headers:idem()});
    expect(created.status,created.text).toBe(201);
    const manager=await s.manager.get('/history');
    expect(manager.status,manager.text).toBe(200);
    expect(new Set(manager.body.items.map((r:{tenderId:string})=>r.tenderId))).toEqual(new Set([s.tenderA,s.tenderB]));
    const files=await s.manager.get('/history/files');
    expect(files.body.items).toHaveLength(4);
    expect(files.body.items.every((f:{tenderId:string;tenderCode:string})=>f.tenderId&&f.tenderCode)).toBe(true);
    const summary=await s.manager.get('/history/summary');
    expect(summary.body.bindings).toHaveLength(2);
    expect(summary.body.tasks).toEqual({open:1,overdue:1});
    const tasks=await s.manager.get('/history/tasks');
    expect(tasks.body.items.find((t:{id:string})=>t.id===created.body.id)).toMatchObject({tender_id:s.tenderB});
  });
  it('глобальные поиск, счётчики, фильтр и курсоры не раскрывают чужой тендер',async()=>{
    for(const [client,id] of [[s.eng1,s.tenderA],[s.eng3,s.tenderB]] as const){
      for(const path of ['/history','/history/files']){
        const page=await client.get(path);
        expect(page.status,page.text).toBe(200);
        expect(page.body.items.length).toBeGreaterThan(0);
        expect(page.body.items.every((r:{tenderId:string})=>r.tenderId===id)).toBe(true);
      }
      const summary=await client.get('/history/summary');
      expect(summary.body.bindings.map((b:{tenderId:string})=>b.tenderId)).toEqual([id]);
      const tasks=await client.get('/history/tasks');
      expect(tasks.body.items.every((t:{tender_id:string})=>t.tender_id===id)).toBe(true);
    }
    expect((await s.eng1.get('/history/summary')).body.tasks).toEqual({open:0,overdue:0});
    expect((await s.eng1.get('/history?q='+encodeURIComponent('Отдельная запись второго'))).body.items).toEqual([]);
    for(const path of ['/history','/history/summary','/history/files','/history/tasks']){
      expect((await s.eng1.get(path+'?tenderId='+s.tenderB)).status).toBe(404);
    }
    const filter=await s.manager.get('/history?tenderId='+s.tenderB);
    expect(filter.body.items.every((r:{tenderId:string})=>r.tenderId===s.tenderB)).toBe(true);
    const first=await s.manager.get('/history?limit=1');
    const next=await s.eng1.get('/history?cursor='+encodeURIComponent(first.body.nextCursor));
    expect(next.status,next.text).toBe(200);
    expect(next.body.items.every((r:{tenderId:string})=>r.tenderId===s.tenderA)).toBe(true);
    expect((await s.admin.get('/history')).status).toBe(403);
    expect((await s.admin.get('/history/summary')).status).toBe(403);
  });
  it('быстрый выбор учитывает события вне первой страницы, но исключает письма и служебные записи',async()=>{
    const events=[...Array.from({length:45},(_,i)=>({id:'quick-'+i,tender_id:'folder-a',folder,kind:'note',title:'Новое изменение '+i,at:'2026-10-24T12:00:00Z'})),
      {id:'quick-baseline',tender_id:'folder-a',folder,kind:'baseline',title:'Исходный снимок',at:'2026-10-24T12:00:00Z'},
      {id:'quick-log',tender_id:'folder-a',folder,kind:'file_modified',title:'Служебный журнал',source:'модель.slog',at:'2026-10-24T12:00:00Z'},
      {id:'quick-mail',tender_id:'folder-a',folder,kind:'mail',title:'Закрытое письмо',at:'2026-10-24T12:00:00Z'}];
    expect((await upload(s.manager,s.tenderA,report('Быстрые фильтры',{events}))).status).toBe(200);
    const page=await s.manager.get('/history?limit=40');expect(page.body.items).toHaveLength(40);expect(page.body.items.every((e:{tenderId:string})=>e.tenderId===s.tenderA)).toBe(true);
    const projects=(await s.manager.get('/history/summary')).body.changedProjects;
    expect(projects.map((p:{tenderId:string})=>p.tenderId)).toEqual([s.tenderA,s.tenderB]);
    const complete=await s.manager.get('/history?limit=100');expect(complete.status,complete.text).toBe(200);const all=complete.body.items;
    for(const project of projects)expect(project.changes).toBe(all.filter((e:{tenderId:string})=>e.tenderId===project.tenderId).length);
    expect((await s.eng3.get('/history/summary')).body.changedProjects.map((p:{tenderId:string})=>p.tenderId)).toEqual([s.tenderB]);
    expect((await s.admin.get('/history/summary')).status).toBe(403);
  });
  it('несколько проектов объединяются до пагинации, без повторов и постороннего проекта',async()=>{
    const third=await s.admin.post('/tenders',{code:'C-multi',title:'Не выбранный проект'},{headers:idem()});expect(third.status,third.text).toBe(201);
    const member=await s.admin.put('/tenders/'+third.body.id+'/members/'+s.ids.manager,{memberRole:'manager'},{headers:{'If-Match':third.headers.etag}});expect(member.status,member.text).toBe(200);
    try{
      const text=report('Не выбранное изменение').replaceAll('folder-a','folder-c').replaceAll(folder,'332. Не выбран');
      const imported=await s.manager.post('/tenders/'+third.body.id+'/history-import?name=third.html&folderId=folder-c&confirmBinding=true',Buffer.from(text),{headers:{...idem(),'Content-Type':'application/octet-stream'}});expect(imported.status,imported.text).toBe(200);
      const selection='tenderId='+s.tenderA+'&tenderId='+s.tenderB+'&tenderId='+s.tenderA;
      for(const path of ['/history','/history/files','/history/tasks']){
        const expected=new Set<string>();
        for(const id of [s.tenderA,s.tenderB]){
          const own=await s.manager.get(path+'?limit=100&tenderId='+id);expect(own.status,own.text).toBe(200);
          for(const item of own.body.items)expected.add(item.id);
        }
        const seen:string[]=[];let cursor:string|null=null;
        do{
          const page=await s.manager.get(path+'?'+selection+'&limit=7'+(cursor?'&cursor='+encodeURIComponent(cursor):''));expect(page.status,page.text).toBe(200);
          for(const item of page.body.items){expect([s.tenderA,s.tenderB]).toContain(item.tenderId??item.tender_id);seen.push(item.id);}
          cursor=page.body.nextCursor??null;
        }while(cursor);
        expect(new Set(seen)).toEqual(expected);expect(seen.length).toBe(expected.size);
      }
      const summary=await s.manager.get('/history/summary?'+selection);expect(summary.status,summary.text).toBe(200);
      expect(new Set(summary.body.bindings.map((b:{tenderId:string})=>b.tenderId))).toEqual(new Set([s.tenderA,s.tenderB]));
      expect(summary.body.tasks).toEqual({open:1,overdue:1});
    }finally{await db.pool.query("UPDATE tender SET status='archived', outcome='won' WHERE id=$1",[third.body.id]);}
  });
  it('каждый выбранный проект проверяется на доступ, некорректные списки отвергаются',async()=>{
    for(const path of ['/history','/history/summary','/history/files','/history/tasks']){
      for(const ids of [[s.tenderA,s.tenderB],[s.tenderB,s.tenderA]]){
        const query=ids.map(id=>'tenderId='+id).join('&');
        expect((await s.eng1.get(path+'?'+query)).status).toBe(404);
        expect((await s.eng3.get(path+'?'+query)).status).toBe(404);
      }
      expect((await s.manager.get(path+'?tenderId='+s.tenderA+'&tenderId=bad')).status).toBe(400);
      expect((await s.manager.get(path+'?tenderId=&tenderId='+s.tenderB)).status).toBe(400);
      expect((await s.manager.get(path+'?scope=common&tenderId='+s.tenderA+'&tenderId='+s.tenderB)).status).toBe(400);
    }
    expect((await s.manager.get('/history?'+Array.from({length:101},()=> 'tenderId='+s.tenderA).join('&'))).status).toBe(400);
  });
  it('завершённый тендер исчезает из ленты, файлов, задач и счётчиков; сохранённые данные остаются',async()=>{
    const counts=async()=>(await db.pool.query('SELECT (SELECT count(*)::int FROM tender_history_record) records,(SELECT count(*)::int FROM tender_history_file) files,(SELECT count(*)::int FROM tender_history_task) tasks')).rows[0];
    const before=await counts();await db.pool.query("UPDATE tender SET status='archived', outcome='won' WHERE id=$1",[s.tenderB]);
    try{
      for(const path of ['/history','/history/files']){
        const page=await s.manager.get(path);expect(page.status,page.text).toBe(200);expect(page.body.items.length).toBeGreaterThan(0);expect(page.body.items.every((r:{tenderId:string})=>r.tenderId===s.tenderA)).toBe(true);
        expect((await s.eng3.get(path)).body.items).toEqual([]);
      }
      const summary=(await s.manager.get('/history/summary')).body;expect(summary.bindings.map((b:{tenderId:string})=>b.tenderId)).toEqual([s.tenderA]);expect(summary.tasks).toEqual({open:0,overdue:0});expect(summary.changedProjects.map((p:{tenderId:string})=>p.tenderId)).toEqual([s.tenderA]);
      const tasks=await s.manager.get('/history/tasks');expect(tasks.body.items.every((t:{tender_id:string})=>t.tender_id!==s.tenderB)).toBe(true);
      expect((await s.manager.get('/history?q='+encodeURIComponent('Отдельная запись второго'))).body.items).toEqual([]);
      expect((await s.manager.get('/history?tenderId='+s.tenderB)).body.items).toEqual([]);
      const selection='tenderId='+s.tenderA+'&tenderId='+s.tenderB;
      for(const path of ['/history','/history/files'])expect((await s.manager.get(path+'?'+selection+'&limit=100')).body.items.every((e:{tenderId:string})=>e.tenderId===s.tenderA)).toBe(true);
      expect((await s.manager.get('/history/summary?'+selection)).body.bindings.map((b:{tenderId:string})=>b.tenderId)).toEqual([s.tenderA]);
      expect((await s.manager.get('/history?tenderId='+s.tenderB+'&tenderId='+s.tenderB)).body.items).toEqual([]);
      expect(await counts()).toEqual(before);
    }finally{await db.pool.query("UPDATE tender SET status='active', outcome=NULL WHERE id=$1",[s.tenderB]);}
    expect((await s.manager.get('/history/summary')).body.bindings).toHaveLength(2);
  });
});
