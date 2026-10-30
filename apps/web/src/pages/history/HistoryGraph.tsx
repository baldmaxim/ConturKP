import type {CSSProperties,FC,ReactNode} from 'react';
import {useNavigate} from 'react-router-dom';
import {Button} from '../../components/Button';
import type {IHistoryEntry,IHistoryTask} from '../../api/historyEndpoints';
import type {ITender} from '../../api/types';
import {historyKind,historySourceKey,historySubject,historyTime} from './historyPresentation';
import styles from './TenderHistoryPanel.module.css';

const calendarDate=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value)):'Без даты';

export const HistoryGraph:FC<{entries:IHistoryEntry[];tasks:IHistoryTask[];tenders:ITender[];selected:string|null;onSelect:(entry:IHistoryEntry)=>void;detail?:ReactNode}>=({entries,tasks,tenders,selected,onSelect,detail})=>{
 const navigate=useNavigate();
 const catalog=[...tenders].sort((a,b)=>a.code.localeCompare(b.code,'ru',{numeric:true}));
 const sources=[...new Map(entries.map(e=>[historySourceKey(e),e])).values()].sort((a,b)=>a.folderName.localeCompare(b.folderName,'ru',{numeric:true}));
 const common=sources.filter(e=>e.tenderId===null);
 const lanes=sources.map((source,index)=>({source,index,key:historySourceKey(source),first:entries.findIndex(e=>historySourceKey(e)===historySourceKey(source)),last:entries.findLastIndex(e=>historySourceKey(e)===historySourceKey(source)),color:source.tenderId?2+Math.max(0,catalog.findIndex(t=>t.id===source.tenderId)):common.findIndex(e=>historySourceKey(e)===historySourceKey(source))}));
 const graphStyle={'--desktop-branch-width':Math.max(36,lanes.length*12+20)+'px','--mobile-branch-width':Math.max(28,lanes.length*6.5+20)+'px'} as CSSProperties;
 const laneStyle=(index:number,color:number)=>({'--branch-index':index,'--branch-color':'var(--history-lane-'+(color%18)+')'} as CSSProperties);
 return <div className={styles.branchGraph} style={graphStyle}>
  <ul className={styles.branchLegend} aria-label="Ветки папок">{lanes.map(lane=><li key={lane.key} style={laneStyle(lane.index,lane.color)}><span className={styles.legendDot} aria-hidden="true"/><span>{lane.source.folderName||('Тендер '+lane.source.tenderCode)}</span></li>)}</ul>
  <div className={styles.branchHeader} aria-hidden="true"><span>Ветки</span><span>Дата и время</span><span>Событие / источник</span></div>
  <ol className={styles.branchEvents} aria-label="Граф хронологии изменений">
   {entries.map((entry,row)=>{const current=lanes.find(lane=>lane.key===historySourceKey(entry))!,task=entry.recordId?tasks.find(t=>t.record_id===entry.recordId):undefined;
    return <li key={entry.id} className={styles.branchRow}>
     <div className={styles.branchRails} aria-hidden="true">{lanes.filter(lane=>row>=lane.first&&row<=lane.last).map(lane=><span key={lane.key} style={laneStyle(lane.index,lane.color)}>{lane.first!==lane.last?<span className={styles.branchRail+' '+(row===lane.first?styles.railStart:'')+' '+(row===lane.last?styles.railEnd:'')}/>:null}{lane.key===current.key?<span className={styles.branchPoint}/>:null}</span>)}</div>
     <div className={styles.branchLine} data-selected={selected===entry.id}>
     <button type="button" className={styles.branchButton} aria-pressed={selected===entry.id} onClick={()=>onSelect(entry)}>
      <span aria-hidden="true"/>
      <time className={styles.branchDate} dateTime={entry.occurredAt??undefined}><b>{calendarDate(entry.occurredAt)}</b><span>{historyTime(entry.occurredAt)}</span></time>
      <span className={styles.branchContent}><span className={styles.branchTitle}><span className={styles.branchChevron} aria-hidden="true">{selected===entry.id?'⌄':'›'}</span>{historySubject(entry)}</span>{entry.importBatch&&entry.importBatch.total>0?<span className={styles.receiptPreview}>{entry.importBatch.uploadName?<span>Загрузка: {entry.importBatch.uploadName}{entry.importBatch.preview.length?' · ':''}</span>:null}{entry.importBatch.preview.join(' · ')}{entry.importBatch.total>entry.importBatch.preview.length?' · ещё '+(entry.importBatch.total-entry.importBatch.preview.length):''}</span>:null}<span className={styles.branchMeta}><span className={styles.kindTag}>{historyKind(entry)}</span><span>{entry.folderName}</span>{task?<span className={styles.taskTag}>{task.status==='resolved'?'Задача решена':task.status==='in_progress'?'Задача в работе':'Открытая задача'}</span>:null}<span className={styles.mobileBranchDate}>{calendarDate(entry.occurredAt)} · {historyTime(entry.occurredAt)}</span></span></span>
     </button>
     {entry.stageId||entry.tenderId?<div className={styles.branchActions} aria-label="Переходы по событию">
      {entry.stageId?<Button onClick={()=>navigate('/stages/'+entry.stageId)}>Открыть этап</Button>:null}
      {entry.tenderId?<Button onClick={()=>navigate('/tenders/'+entry.tenderId)}>Открыть тендер</Button>:null}
     </div>:null}
     </div>
     {selected===entry.id&&detail?<div className={styles.branchExpansion}>{detail}</div>:null}
    </li>;
   })}
  </ol>
 </div>;
};
