import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {emitStageEvents,type StageEventType} from '../packages/db/src/stageEvents.ts';
import {buildScenario,createTestDb,makeApp,type IScenario,type ITestDb} from './helpers.ts';

const titles:Record<StageEventType,string>={
 import_accepted:'Поступил комплект документов',document_revision_registered:'Зарегистрирована редакция документа',
 source_set_changed:'Изменён состав документов этапа',recognition_run_completed:'Завершено распознавание документа',
 calculation_revision_added:'Добавлена ревизия расчёта',communication_linked:'Связана переписка с этапом',
 transcript_revision_added:'Обновлена расшифровка',qa_form_added:'Добавлены вопросы и ответы',
 decision_recorded:'Записано решение',draft_field_changed:'Изменено поле приложения',
};
const technical=new Set(['document_revision_registered','recognition_run_completed']);
let db:ITestDb,s:IScenario;
const emit=async(tenderId:string,stageId:string,types:StageEventType[],actorUserId:string|null)=>{
 const client=await db.pool.connect();try{await client.query('BEGIN');
  for(const eventType of types)await emitStageEvents(client,{tenderId,stageIds:[stageId],eventType,refType:'history_test',refId:randomUUID(),actorUserId});
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
};
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db));
 await emit(s.tenderA,s.stageA,Object.keys(titles) as StageEventType[],s.ids.manager);
 await emit(s.tenderA,s.stageA,Array.from({length:40},(_,i)=>i%2?'recognition_run_completed':'document_revision_registered'),null);
 await emit(s.tenderB,s.stageB,['import_accepted'],s.ids.manager);
});
afterAll(async()=>{await db?.drop();});
describe('содержательная хронология портала',()=>{
 it('служебные события не занимают страницы обычной ленты и сохраняются по флажку',async()=>{
  const seen:string[]=[];let cursor:string|null=null;
  do{const r=await s.eng1.get('/history?limit=2&fileFacts=false'+(cursor?'&cursor='+cursor:''));expect(r.status,r.text).toBe(200);
   expect(r.body.items.length).toBeGreaterThan(0);expect(r.body.items.every((e:{technical:boolean;kind:string})=>!e.technical&&!technical.has(e.kind))).toBe(true);
   seen.push(...r.body.items.map((e:{id:string})=>e.id));cursor=r.body.nextCursor;
  }while(cursor);
  expect(seen).toHaveLength(8);expect(new Set(seen).size).toBe(8);
  const full=await s.eng1.get('/history?technical=true&limit=100&fileFacts=false');expect(full.status,full.text).toBe(200);expect(full.body.items).toHaveLength(50);
  expect(full.body.items.filter((e:{technical:boolean})=>e.technical)).toHaveLength(42);
  expect(full.body.items.some((e:{actorKind:string})=>e.actorKind==='system')).toBe(true);
  expect((await db.pool.query('SELECT count(*)::int n FROM stage_input_event')).rows[0].n).toBe(51);
 });
 it('каждый тип получает конкретный заголовок, этап, тендер и настоящего автора',async()=>{
  const full=await s.eng1.get('/history?technical=true&limit=100');expect(full.status,full.text).toBe(200);
  for(const [kind,title] of Object.entries(titles)){
   const rows=full.body.items.filter((e:{kind:string})=>e.kind===kind);expect(rows.length).toBeGreaterThan(0);
   for(const row of rows)expect(row).toMatchObject({title,technical:technical.has(kind),stageId:s.stageA,tenderId:s.tenderA,folderName:'Этап A1'});
  }
  const human=full.body.items.find((e:{kind:string})=>e.kind==='source_set_changed');expect(human).toMatchObject({actorName:'Руководитель',actorKind:'human'});
  expect(JSON.stringify(full.body)).not.toContain('Изменение входов этапа');
 });
 it('счётчики проектов совпадают с обычной лентой, поиск не возвращает скрытую служебную запись',async()=>{
  const summary=await s.eng1.get('/history/summary');expect(summary.status,summary.text).toBe(200);expect(summary.body.changedProjects).toHaveLength(1);
  expect(summary.body.changedProjects[0]).toMatchObject({tenderId:s.tenderA,changes:8});
  const query='&q='+encodeURIComponent('Зарегистрирована редакция');
  expect((await s.eng1.get('/history?limit=100'+query)).body.items).toEqual([]);
  expect((await s.eng1.get('/history?technical=true&limit=100'+query)).body.items).toHaveLength(21);
  expect((await s.eng1.get('/history?q='+encodeURIComponent('состав документов'))).body.items[0]).toMatchObject({kind:'source_set_changed'});
 });
 it('флажок и курсор сохраняют границы доступа к тендерам',async()=>{
  const first=await s.manager.get('/history?technical=true&limit=1');expect(first.status,first.text).toBe(200);
  const next=await s.eng1.get('/history?technical=true&limit=100&cursor='+first.body.nextCursor);expect(next.status,next.text).toBe(200);
  expect(next.body.items.every((e:{tenderId:string})=>e.tenderId===s.tenderA)).toBe(true);
  expect((await s.eng3.get('/history?technical=true')).body.items).toHaveLength(1);
  expect((await s.eng3.get('/history?technical=true&tenderId='+s.tenderA)).status).toBe(404);
 });
});
