import {useEffect,useRef,useState,type FC} from 'react';
import {useNavigate} from 'react-router-dom';
import type {IHistoryEntry,IHistoryTask} from '../../api/historyEndpoints';
import type {ITender} from '../../api/types';
import {Button} from '../../components/Button';
import {HistoryGraph} from './HistoryGraph';
import {HistoryImportDetails} from './HistoryImportDetails';
import {HistoryContentComparison} from './HistoryContentComparison';
import {HistoryFileFacts} from './HistoryFileFacts';
import {historyDate,historyKind,historySubject,historyFileDescription} from './historyPresentation';
import styles from './TenderHistoryPanel.module.css';

const hasFileFacts=(entry:IHistoryEntry)=>!!entry.recordId&&!!entry.sourcePath&&['file_added','file_modified','file_missing','file_restored','file_content_changed'].includes(entry.kind);

export const HistoryFeed:FC<{entries:IHistoryEntry[];tasks:IHistoryTask[];tenders:ITender[];canWrite:(id:string|null)=>boolean;onTask:(entry:IHistoryEntry,task?:IHistoryTask)=>void}>=({entries,tasks,tenders,canWrite,onTask})=>{
 const navigate=useNavigate();
 const [selected,setSelected]=useState<string|null>(null);
 const inspector=useRef<HTMLElement>(null);
 useEffect(()=>{if(selected)inspector.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[selected]);
 const entry=entries.find(e=>e.id===selected),task=entry?.recordId?tasks.find(t=>t.record_id===entry.recordId):undefined;
 const detail=entry?<article ref={inspector} className={styles.inspector} aria-label="Выбранное изменение">
   <div className={styles.sectionHead}><span className={styles.badge}>{historyKind(entry)}{!hasFileFacts(entry)?' · '+historyDate(entry.occurredAt):''}</span><Button variant="ghost" onClick={()=>setSelected(null)}>Закрыть</Button></div>
   <h3>{hasFileFacts(entry)?historySubject(entry):entry.title}</h3><p className={styles.path}>{entry.folderName}{entry.sourcePath?' / '+entry.sourcePath:''}</p>
   {hasFileFacts(entry)?<HistoryFileFacts key={entry.id} recordId={entry.recordId!} occurredAt={entry.occurredAt} kind={entry.kind}/>:null}
   {hasFileFacts(entry)?<p>{historyFileDescription(entry.kind)}</p>:entry.detail?<div className={styles.changeDetail}>{entry.detail}</div>:null}
   {entry.importBatch?<HistoryImportDetails key={entry.id} id={entry.importBatch.id}/>:null}
   {entry.origin==='portal'?<p className={styles.muted}>Кем изменено: {entry.actorKind==='system'?'Система':entry.actorName??'Не указан'}</p>:null}
   {entry.recordId&&entry.sourcePath&&['file_added','file_modified','file_missing','file_restored','file_content_changed'].includes(entry.kind)?<HistoryContentComparison key={entry.id} recordId={entry.recordId}/>:null}
   {entry.stageId?<div className={styles.bar}><Button onClick={()=>navigate('/stages/'+entry.stageId)}>Открыть этап</Button></div>:entry.recordId&&canWrite(entry.tenderId)?<div className={styles.bar}><Button onClick={()=>onTask(entry,task)}>{task?'Открыть задачу':'Создать задачу'}</Button></div>:null}
   <p className={styles.registration}>Источник: {entry.origin==='observation'?'Папка Tender':entry.sourceLabel}</p>
  </article>:null;
 return <section className={styles.stack} aria-label="Изменения">
  <div className={styles.sectionHead}><h2>Хронология изменений</h2><span className={styles.muted}>Событий на странице: {entries.length}</span></div>
  {!entries.length?<div className={styles.empty}>Изменений по выбранным условиям нет. Редакции документов, распознавание и исходные снимки доступны при включении служебных записей.</div>:<HistoryGraph entries={entries} tasks={tasks} tenders={tenders} selected={selected} onSelect={e=>setSelected(current=>current===e.id?null:e.id)} detail={detail}/>}
 </section>;
};
