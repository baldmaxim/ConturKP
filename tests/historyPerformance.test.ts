import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {buildScenario,createTestDb,idem,makeApp,type IScenario,type ITestDb} from './helpers.ts';
let db:ITestDb,s:IScenario,bindingB:string;
const report=(source:string,count:number,at:string,stale=false)=>JSON.stringify({folders:[{id:source,tender_id:source,tender:true}],snapshot:{started_at:at,finished_at:at,complete:true},
 events:[{id:'added-'+source,tender_id:source,folder:source,kind:'file_added',title:'Добавлен f-000.txt',source:'f-000.txt',at}],
 files:[...Array.from({length:count},(_,i)=>({p:source+'/f-'+String(i).padStart(3,'0')+'.txt',tender_id:source,s:i+1,h:(source==='A'?'a':'b').repeat(64),st:'ok',m:at})),
 ...['Thumbs.db','model.slog',...(stale?['legacy-removed.txt']:[])].map(p=>({p:source+'/'+p,tender_id:source,s:1,h:'c'.repeat(64),st:'ok',m:at}))]});
const upload=async(id:string,source:string,count:number,at:string,stale=false)=>{const r=await s.manager.post('/tenders/'+id+'/history-import?name=history.json&folderId='+source+'&confirmBinding=true',Buffer.from(report(source,count,at,stale)),{headers:{...idem(),'Content-Type':'application/octet-stream'}});expect(r.status,r.text).toBe(200);return r.body;};
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db));await upload(s.tenderA,'A',140,'2026-10-24T09:00:00Z',true);await upload(s.tenderA,'A',130,'2026-10-26T09:00:00Z');
 const b=await upload(s.tenderB,'B',100,'2026-10-26T09:00:00Z');bindingB=b.bindingId;
 await db.pool.query("INSERT INTO tender_history_watch(binding_id,root_path,configured_by) VALUES($1,'unused-test-root',$2)",[bindingB,s.ids.manager]);
 await db.pool.query(`INSERT INTO tender_history_observation(binding_id,path_key,relative_path,file_id,size_bytes,mtime_ms,sha256,stable_since,last_seen_at,present,status)
 SELECT binding_id,path_key,relative_path,id,size_bytes,0,sha256,now(),now(),relative_path<>'f-003.txt',CASE WHEN relative_path='f-003.txt' THEN 'missing' ELSE 'ok' END
 FROM tender_history_file WHERE binding_id=$1 AND import_id=$2`,[bindingB,b.importId]);
});
afterAll(async()=>{await db?.drop();});
const pages=async(query='')=>{const rows:{id:string;tenderId:string;path:string;status:string}[]=[];let cursor:string|null=null;
 do{const r=await s.manager.get('/history/files?limit=7'+query+(cursor?'&cursor='+cursor:''));expect(r.status,r.text).toBe(200);rows.push(...r.body.items);cursor=r.body.nextCursor;}while(cursor);return rows;};
describe('быстрое чтение хронологии',()=>{
 it('объединяет последние HTML-снимки и наблюдение с полной пагинацией без повторов',async()=>{const rows=await pages();expect(rows).toHaveLength(230);expect(new Set(rows.map(r=>r.id)).size).toBe(230);
 for(const [id,n] of [[s.tenderA,130],[s.tenderB,100]] as const){const paths=rows.filter(r=>r.tenderId===id).map(r=>r.path);expect(paths).toEqual(Array.from({length:n},(_,i)=>'f-'+String(i).padStart(3,'0')+'.txt'));}
 expect(rows.find(r=>r.tenderId===s.tenderB&&r.path==='f-003.txt')?.status).toBe('missing');
 expect(await pages('&technical=true')).toHaveLength(234);expect(await pages('&q=f-00')).toHaveLength(20);
 const hash=await pages('&q='+'b'.repeat(64));expect(hash).toHaveLength(100);expect(hash.every(r=>r.tenderId===s.tenderB)).toBe(true);
 for(const [client,id] of [[s.eng1,s.tenderA],[s.eng3,s.tenderB]] as const){const r=await client.get('/history/files?limit=100');expect(r.body.items.every((f:{tenderId:string})=>f.tenderId===id)).toBe(true);}
 });
 it('сохраняет границу пути, когда новый снимок заменяет UUID файла между страницами',async()=>{const first=await s.manager.get('/history/files?tenderId='+s.tenderA+'&limit=1');expect(first.body.items[0].path).toBe('f-000.txt');await upload(s.tenderA,'A',130,'2026-10-26T10:00:00Z');
 const next=await s.manager.get('/history/files?tenderId='+s.tenderA+'&limit=1&cursor='+first.body.nextCursor);expect(next.status,next.text).toBe(200);expect(next.body.items[0].path).toBe('f-001.txt');
 });
 it('лёгкая лента сохраняет события и не запускает поиск предыдущих файлов',async()=>{const full=await s.manager.get('/history?limit=100');expect(full.status,full.text).toBe(200);const spy=vi.spyOn(db.pool,'query');
 try{const light=await s.manager.get('/history?limit=100&fileFacts=false');expect(light.status,light.text).toBe(200);expect(light.body.items.map((r:{id:string})=>r.id)).toEqual(full.body.items.map((r:{id:string})=>r.id));expect(light.body.items.every((r:{fileChange:unknown})=>r.fileChange===null)).toBe(true);
 expect(spy.mock.calls.some(args=>typeof args[0]==='string'&&args[0].includes('AS e(id text'))).toBe(false);
 }finally{spy.mockRestore();}
 });
});
