import {useEffect,useRef,useState,type FC,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {configureHistoryWatch,configureHistorySync,getHistoryReportSources,createHistoryTask,getHistory,getHistorySummary,getHistoryTasks,listSharedHistoryMembers,updateHistoryTask,uploadHistory,type HistoryScope,type IHistoryWatch,type IHistoryBinding,type IHistorySync,type IHistoryEntry,type IHistoryFile,type IHistoryTask,type IHistoryTaskInput,type IHistorySummary} from '../../api/historyEndpoints';
import {listMembers} from '../../api/endpoints';
import type {ITender} from '../../api/types';
import {Button} from '../../components/Button';
import {ErrorState} from '../../components/ErrorState';
import {LoadingState} from '../../components/LoadingState';
import {Notice} from '../../components/Notice';
import {useApiResource,type IApiResource} from '../../hooks/useApiResource';
import styles from './TenderHistoryPanel.module.css';
import {HistoryFeed} from './HistoryFeed';
import {historyBackground,historyDate as dt} from './historyPresentation';

const stateLabel={open:'Открыта',in_progress:'В работе',resolved:'Решена'};
const errText=(err:unknown)=>err instanceof Error?err.message:'Действие не выполнено';
const localDue=(value:string|null)=>value?new Date(new Date(value).getTime()+3*3600_000).toISOString().slice(0,16):'';
const dueIso=(value:string)=>value?new Date(value+':00+03:00').toISOString():null;
const HistorySource:FC<{id:string|null;code:string}>=({id,code})=>id?<Link to={'/tenders/'+id}>{code}</Link>:<span className={styles.badge}>Общие материалы</span>;
const WatchStatus:FC<{binding:IHistoryBinding;watch:IHistoryWatch;onDone:()=>void}>=({binding,watch,onDone})=>{
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const toggle=async()=>{setBusy(true);setError('');try{await configureHistoryWatch(binding.tenderId,watch,!watch.enabled);onDone();}catch(err){setError(errText(err));}finally{setBusy(false);}};
 return <Notice tone={watch.lastErrorCode?'warning':'info'}><strong>{binding.tenderId?binding.tenderCode:binding.folderName} · {watch.enabled?'Наблюдение Tender включено':'Наблюдение Tender приостановлено'}</strong><p>{binding.files} файлов · {watch.directories} каталогов · обход каждые {Math.round(watch.intervalSeconds/60)} мин · проверка {dt(watch.lastCheckedAt)} · последний полный обход {dt(watch.lastSuccessAt)}.</p><p>Ночная сверка содержимого: {dt(watch.lastFullHashAt)} · ожидают SHA-256: {watch.unverified}.</p>{watch.lastErrorCode?<p>Часть источника не проверена. Прежние сведения сохранены; отсутствие файлов при ошибке не фиксируется.</p>:null}{binding.canManage?<Button loading={busy} onClick={()=>void toggle()}>{watch.enabled?'Приостановить наблюдение':'Возобновить наблюдение'}</Button>:null}{error?<p role="alert">{error}</p>:null}</Notice>;
};

const SyncSettings:FC<{tenderId:string;binding:IHistoryBinding;sync?:IHistorySync;onDone:()=>void}>=({tenderId,binding,sync,onDone})=>{
  const sources=useApiResource(signal=>getHistoryReportSources(tenderId,signal),tenderId);
  const [key,setKey]=useState(''),[enabled,setEnabled]=useState(sync?.enabled??false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');
    try{await configureHistorySync(tenderId,binding.id,sync?.rowVersion??0,key,enabled);onDone();}
    catch(err){setError(errText(err));}finally{setBusy(false);}
  };
  return <details><summary>Обновление: {binding.folderName}</summary>
    {sources.error?<ErrorState error={sources.error} onRetry={sources.reload}/>:sources.loading?<LoadingState/>:!sources.data?.items.length?<p className={styles.muted}>Файлы отчётов для фонового чтения задаёт администратор сервера.</p>:<form className={styles.form} onSubmit={event=>void save(event)}>
      <label>Разрешённый отчёт<select value={key} onChange={event=>setKey(event.target.value)} required><option value="">Выберите источник</option>{sources.data.items.map(source=><option key={source.key} value={source.key}>{source.label}</option>)}</select></label>
      <label className={styles.check}><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>Проверять обновления отчёта каждые 5 минут</label>
      <p className={styles.muted}>Обновляется готовая хронология. Новые снимки файлов продолжает создавать её сборщик по своему расписанию.</p>
      {error?<p role="alert" className={styles.error}>{error}</p>:null}<Button type="submit" loading={busy} disabled={!key}>Сохранить</Button>
    </form>}
  </details>;
};

const ImportHistory:FC<{tender:ITender;onDone:()=>void}>=({tender,onDone})=>{
  const [file,setFile]=useState<File|null>(null),[folders,setFolders]=useState<{id:string;name:string}[]>([]),[folder,setFolder]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [error,setError]=useState(''),[progress,setProgress]=useState<number|null>(null),[message,setMessage]=useState('');
  const sequence=useRef(0),upload=useRef<{abort:()=>void}|null>(null);
  useEffect(()=>()=>{sequence.current++;upload.current?.abort();},[]);
  const inspect=async(next:File|undefined)=>{
    const seq=++sequence.current;setFile(null);setFolders([]);setFolder('');setConfirmed(false);setError('');setMessage('');
    if(!next)return;
    try {
      if(next.size>40*1024*1024)throw new Error('Отчёт больше 40 МБ');
      const text=await next.text();
      const match=/<script\b(?=[^>]*\bid=["']history-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(text);
      const data=JSON.parse(match?match[1]!:text) as {folders?:{tender?:boolean;tender_id?:string;id?:string}[]};
      if(!Array.isArray(data.folders))throw new Error('В отчёте нет реестра папок');
      const items=data.folders.filter(f=>f.tender===true&&typeof f.tender_id==='string'&&typeof f.id==='string').map(f=>({id:f.tender_id!,name:f.id!}));
      if(seq!==sequence.current)return;
      setFolders(items);setFile(next);
    }catch(err){if(seq===sequence.current)setError(errText(err));}
  };
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(!file||!folder||!confirmed)return;
    setError('');setProgress(0);
    const handle=uploadHistory(tender.id,file,folder,setProgress);upload.current=handle;
    try{const result=await handle.promise;setMessage(result.repeated?'Этот отчёт уже импортирован.':'Добавлено записей: '+result.recordsAdded+'; файлов в реестре: '+result.filesAdded+'.');onDone();}
    catch(err){setError(errText(err));}finally{setProgress(null);upload.current=null;}
  };
  return <details><summary>Подключить историю из отчёта</summary><form className={styles.form} onSubmit={event=>void submit(event)}>
    <p>Выберите HTML или JSON хронологии. В портал поступят записи и сведения о файлах. Оригиналы документов остаются в сетевой папке.</p>
    <label>Файл хронологии<input type="file" accept=".html,.json" disabled={progress!==null} onChange={event=>void inspect(event.target.files?.[0])}/></label>
    {folders.length>0?<label>Папка в отчёте<select value={folder} onChange={event=>{setFolder(event.target.value);setConfirmed(false);}} disabled={progress!==null}><option value="">Выберите папку</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>:null}
    {folder?<label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={progress!==null}/><span>Подтверждаю: выбранная папка относится к карточке {tender.code} «{tender.title}». Записи, требующие проверки принадлежности, разберём отдельно.</span></label>:null}
    <Notice tone="info">Исторические пометки о решениях сохраняются как записи источника. Текст исторических писем закрыт; оригиналы просматриваются в разделе переписки с соответствующими правами.</Notice>
    {error?<p role="alert" className={styles.error}>{error}</p>:null}{message?<p role="status">{message}</p>:null}
    <Button type="submit" loading={progress!==null} disabled={!file||!folder||!confirmed}>Импортировать выбранную папку{progress!==null?' · '+Math.round(progress*100)+'%':''}</Button>
  </form></details>;
};

const TaskForm:FC<{tenderId:string|null;draft:IHistoryTaskInput;task?:IHistoryTask;onDone:()=>void;onCancel:()=>void}>=({tenderId,draft,task,onDone,onCancel})=>{
  const members=useApiResource(async signal=>({items:tenderId?(await listMembers(tenderId,signal)).items.map(m=>({userId:m.userId,displayName:m.displayName})):(await listSharedHistoryMembers(signal)).items}),tenderId??'common');
  const [title,setTitle]=useState(draft.title),[owner,setOwner]=useState(task?.owner_user_id??''),[due,setDue]=useState(localDue(task?.due_at??null));
  const [status,setStatus]=useState<IHistoryTask['status']>(task?.status??'open'),[resolution,setResolution]=useState(task?.resolution??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setBusy(true);setError('');
    try{if(task)await updateHistoryTask(task,{status,ownerUserId:owner||null,dueAt:dueIso(due),resolution:resolution.trim()||null});
      else await createHistoryTask(tenderId,{...draft,title,ownerUserId:owner||null,dueAt:dueIso(due)});onDone();}
    catch(err){setError(errText(err));}finally{setBusy(false);}
  };
  return <form className={styles.form} onSubmit={event=>void submit(event)}>
    <label>Что нужно проверить<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={2000} required disabled={!!task}/></label>
    <label>Ответственный<select value={owner} onChange={event=>setOwner(event.target.value)}><option value="">Не назначен</option>{members.data?.items.map(m=><option key={m.userId} value={m.userId}>{m.displayName}</option>)}</select></label>
    <label>Срок<input type="datetime-local" value={due} onChange={event=>setDue(event.target.value)}/></label>
    {task?<><label>Состояние<select value={status} onChange={event=>setStatus(event.target.value as IHistoryTask['status'])}>{Object.entries(stateLabel).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>Результат разбора<textarea value={resolution} onChange={event=>setResolution(event.target.value)} required={status==='resolved'} maxLength={10000}/></label></>:null}
    {error?<p role="alert" className={styles.error}>{error}</p>:null}
    <div className={styles.bar}><Button type="submit" loading={busy}>Сохранить</Button><Button onClick={onCancel} disabled={busy}>Отмена</Button></div>
  </form>;
};

interface IHistoryPanelProps {tender:ITender|null;tenders:ITender[];selectedIds?:string[];scope?:HistoryScope;onRefresh?:()=>void;sharedSummary?:IApiResource<IHistorySummary>}
const ScopedHistoryPanel:FC<IHistoryPanelProps>=props=>{
 const filter=props.selectedIds?.length===1?props.selectedIds[0]!:props.selectedIds?.length?props.selectedIds:props.tender?.id??null;
 const summary=useApiResource(signal=>getHistorySummary(filter,signal,props.scope),JSON.stringify([filter,props.scope]));
 return <HistoryPanelBody {...props} summary={summary}/>;
};
export const TenderHistoryPanel:FC<IHistoryPanelProps>=props=>props.sharedSummary?<HistoryPanelBody {...props} summary={props.sharedSummary}/>:<ScopedHistoryPanel {...props}/>;
const HistoryPanelBody:FC<IHistoryPanelProps&{summary:IApiResource<IHistorySummary>}>=({tender,tenders,selectedIds,scope='all',onRefresh,summary})=>{
  const [view,setView]=useState<'history'|'history-files'|'tasks'>('history'),[q,setQ]=useState(''),[technical,setTechnical]=useState(false),[cursor,setCursor]=useState<string|null>(null),[version,setVersion]=useState(0);
  const [settings,setSettings]=useState(false),[bindingId,setBindingId]=useState<string|null>(null);
  const [draft,setDraft]=useState<{tenderId:string|null;input:IHistoryTaskInput}|null>(null),[editing,setEditing]=useState<IHistoryTask|undefined>();
  const draftBox=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(draft)draftBox.current?.scrollIntoView({block:'center',behavior:'smooth'});},[draft]);
  const id=tender?.id??null;
  const filter=selectedIds?.length===1?selectedIds[0]!:selectedIds?.length?selectedIds:id;
  const [search,setSearch]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>{setSearch(q);setCursor(null);},250);return ()=>clearTimeout(timer);},[q]);
  const page=useApiResource(signal=>getHistory(filter,view==='history-files'?'history-files':'history',search,technical,cursor,signal,scope),JSON.stringify([filter,scope,view,search,technical,cursor,version]));
  const tasks=useApiResource(signal=>getHistoryTasks(filter,signal,scope),JSON.stringify([filter,scope,'tasks',version]));
  const canWrite=(tenderId:string|null)=>tenderId===null?summary.data?.canWriteCommon===true:tenders.some(t=>t.id===tenderId&&t.capabilities.includes('source.write'));
  const startTask=(tenderId:string|null,input:IHistoryTaskInput,task?:IHistoryTask)=>{setEditing(task);setDraft({tenderId,input});};
  const reload=()=>{setVersion(v=>v+1);summary.reload();onRefresh?.();};
  const finish=()=>{setDraft(null);setEditing(undefined);reload();};
  if(summary.loading&&!summary.data)return <LoadingState/>;
  if(summary.error)return <ErrorState error={summary.error} onRetry={summary.reload}/>;
  if(!summary.data)return <Notice tone="warning">Выбранные проекты завершены или больше недоступны. Обновите страницу и измените выбор.</Notice>;
  const data=summary.data!,background=historyBackground(data),binding=data.bindings.find(b=>b.id===bindingId),watch=data.watch.find(w=>w.bindingId===bindingId);
  return <div className={styles.stack}>
    <div className={styles.summary}><span><strong>{data.bindings.length}</strong> подключённых папок</span><span><strong>{data.tasks.open}</strong> открытых задач</span>{data.tasks.overdue?<span className={styles.error}><strong>{data.tasks.overdue}</strong> просрочено</span>:null}<Button variant="ghost" aria-expanded={settings} onClick={()=>setSettings(!settings)}>Источники и настройки</Button></div>
    <Notice tone={background.failed?'warning':'info'}>{background.enabled?'Фоновое обновление включено · '+background.enabled+' папок':'Фоновое обновление выключено'}{background.lastSuccess?' · проверено '+dt(background.lastSuccess):''}{background.failed?' · не удалось проверить папок: '+background.failed+'. Показаны последние доступные данные.':''}</Notice>
    {settings?<section className={styles.settings} aria-label="Источники и настройки">
      <h2>Подключённые источники</h2>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Папка</th><th>Файлов</th><th>Обновление</th><th>Проверка</th><th/></tr></thead><tbody>{data.bindings.map(b=>{const w=data.watch.find(v=>v.bindingId===b.id),s=data.sync.find(v=>v.bindingId===b.id);return <tr key={b.id}><td><HistorySource id={b.tenderId} code={b.tenderCode}/><div>{b.folderName}</div></td><td>{b.files.toLocaleString('ru-RU')}</td><td>{w?.lastErrorCode||s?.lastErrorCode?'Ошибка проверки':w?.enabled||s?.enabled?'Работает':'Приостановлено'}</td><td>{dt(w?.lastCheckedAt??s?.lastCheckedAt??null)}</td><td>{b.canManage?<Button onClick={()=>setBindingId(bindingId===b.id?null:b.id)} aria-expanded={bindingId===b.id}>Настроить</Button>:null}</td></tr>;})}</tbody></table></div>
      {binding&&watch?<WatchStatus key={watch.bindingId+':'+watch.rowVersion} binding={binding} watch={watch} onDone={reload}/>:null}
      {binding?.canManage&&binding.tenderId?<SyncSettings key={binding.id+':'+version} tenderId={binding.tenderId} binding={binding} sync={data.sync.find(s=>s.bindingId===binding.id)} onDone={reload}/>:null}
      {data.related.map(r=><p key={r.tenderId} className={styles.muted}>Общая папка с тендером {r.tenderCode}. {r.reason}</p>)}
      {data.canManage&&tender?<ImportHistory tender={tender} onDone={reload}/>:null}
    </section>:null}
    <div className={styles.bar} aria-label="Разделы хронологии">{([['history','Изменения'],['history-files','Файлы'],['tasks','Задачи · '+data.tasks.open]] as const).map(([key,label])=><Button key={key} variant={view===key?'primary':'secondary'} aria-pressed={view===key} onClick={()=>{setView(key);setCursor(null);setQ('');setSearch('');}}>{label}</Button>)}<Button variant="ghost" onClick={reload}>Обновить</Button></div>
    {view!=='tasks'?<div className={styles.bar}><label className={styles.searchLabel}>Поиск<input type="search" value={q} onChange={event=>{setQ(event.target.value);}} placeholder={view==='history-files'?'Файл или путь':'Файл, событие или текст изменения'}/></label><label className={styles.check}><input type="checkbox" checked={technical} onChange={event=>{setTechnical(event.target.checked);setCursor(null);}}/>Служебные записи и исходные снимки</label></div>:null}
    {draft?<div ref={draftBox} className={styles.stack}><h2>{editing?'Задача':'Создать задачу'}</h2><p className={styles.muted}>{draft.tenderId?'Тендер '+tenders.find(t=>t.id===draft.tenderId)?.code:'Общие материалы'} · укажите, что проверить, ответственного и срок.</p><TaskForm key={editing?.id??draft.input.recordId??draft.input.fileId??'new'} tenderId={draft.tenderId} draft={draft.input} task={editing} onDone={finish} onCancel={()=>{setDraft(null);setEditing(undefined);}}/></div>:null}
    {view==='tasks'?<>
      {(tender&&canWrite(tender.id))||(scope==='common'&&canWrite(null))?<Button onClick={()=>startTask(id,{title:''})}>Создать задачу</Button>:null}
      {tasks.error?<ErrorState error={tasks.error} onRetry={tasks.reload}/>:tasks.loading&&!tasks.data?<LoadingState/>:tasks.data?.items.length===0?<p className={styles.empty}>Открытых вопросов пока нет. Задачу можно создать из конкретного изменения или файла.</p>:tasks.data?.items.map(task=><article key={task.id} className={styles.record}><span className={styles.badge}>{stateLabel[task.status]}</span> <HistorySource id={task.tender_id} code={task.tender_code}/><h3>{task.title}</h3><p className={styles.muted}>{task.owner_name??'Ответственный не назначен'} · срок {dt(task.due_at)}</p>{task.resolution?<p className={styles.detail}>{task.resolution}</p>:null}{canWrite(task.tender_id)?<Button onClick={()=>startTask(task.tender_id,{title:task.title},task)}>Открыть задачу</Button>:null}</article>)}
    </>:page.error?<ErrorState error={page.error} onRetry={page.reload}/>:page.loading&&!page.data?<LoadingState/>:view==='history-files'?<>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Файл / папка</th><th>Размер</th><th>Изменён</th><th>Проверка содержимого</th><th/></tr></thead><tbody>{(page.data?.items as IHistoryFile[]|undefined)?.map(file=><tr key={file.id}><td><strong>{file.path.split('/').at(-1)}</strong><p className={styles.path}>{file.folderName+'/'+file.path}</p><HistorySource id={file.tenderId} code={file.tenderCode}/></td><td>{(file.size/1048576).toLocaleString('ru-RU',{maximumFractionDigits:2})} МБ</td><td>{dt(file.modifiedAt)}</td><td>{dt(file.verifiedAt)}<div className={styles.muted} title={file.sha256??'Содержимое ещё не проверено'}>{file.sha256?'SHA-256 '+file.sha256.slice(0,12)+'…':'Ожидает проверки'}</div>{file.status==='missing'?<span className={styles.error}>Путь отсутствует</span>:null}</td><td>{canWrite(file.tenderId)?<Button onClick={()=>startTask(file.tenderId,{title:'Проверить: '+file.path,fileId:file.id})}>Создать задачу</Button>:null}</td></tr>)}</tbody></table></div>
      <p className={styles.muted}>Реестр содержит сведения о файлах. Проверка SHA-256 подтверждает содержимое на указанное время; прежние версии документов могут отсутствовать в портале.</p>
    </>:<>{tasks.error?<ErrorState error={tasks.error} onRetry={tasks.reload}/>:null}<HistoryFeed key={JSON.stringify([id,scope,search,technical,cursor,version])} entries={(page.data?.items??[]) as IHistoryEntry[]} tasks={tasks.data?.items??[]} tenders={tenders} canWrite={canWrite} onTask={(entry,task)=>startTask(entry.tenderId,{title:entry.title,recordId:entry.recordId},task)}/></>}
    {view!=='tasks'?<div className={styles.pager}>{cursor?<Button onClick={()=>setCursor(null)}>В начало</Button>:null}{page.data?.nextCursor?<Button onClick={()=>setCursor(page.data!.nextCursor)}>Следующая страница</Button>:null}</div>:null}
  </div>;
};
