import type { FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listTenders } from '../../api/endpoints';
import { getHistorySummary } from '../../api/historyEndpoints';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { useApiResource } from '../../hooks/useApiResource';
import { TenderHistoryPanel } from './TenderHistoryPanel';
import { HistoryProjectFilters } from './HistoryProjectFilters';
import { Button } from '../../components/Button';
import styles from './TenderHistoryPanel.module.css';

export const HistoryPage:FC=()=>{
  const [params,setParams]=useSearchParams();
  const tenders=useApiResource(signal=>listTenders(signal),'history-tenders');
  const projects=useApiResource(signal=>getHistorySummary(null,signal),'history-quick-projects');
  const selected=[...new Set(params.getAll('tender'))];
  const scope=selected.length?'tenders':params.get('scope')==='common'?'common':params.get('scope')==='tenders'?'tenders':'all';
  if(tenders.loading&&!tenders.data)return <LoadingState/>;
  if(tenders.error)return <ErrorState error={tenders.error} onRetry={tenders.reload}/>;
  const readable=(tenders.data?.items??[]).filter(t=>t.capabilities.includes('tender.read'));
  const items=readable.filter(t=>t.status==='active');
  const unavailable=selected.filter(id=>!items.some(t=>t.id===id));
  const tender=selected.length===1?items.find(t=>t.id===selected[0])??null:null;
  const selectSource=(value:string)=>setParams(current=>{
    const next=new URLSearchParams(current);next.delete('tender');next.delete('scope');
    if(value==='common'||value==='tenders')next.set('scope',value);
    else if(value!=='all'){
      const ids=[...new Set(current.getAll('tender'))];
      for(const id of ids.includes(value)?ids.filter(id=>id!==value):[...ids,value])next.append('tender',id);
    }
    return next;
  });
  const projectFilters=[...(projects.data?.changedProjects??[])];
  for(const id of selected)if(!projectFilters.some(p=>p.tenderId===id)){
    const item=readable.find(t=>t.id===id);
    projectFilters.push({tenderId:id,tenderCode:item?.code??'Недоступен',title:item?.title??'Убрать из выбора',changes:0,lastChangedAt:''});
  }
  return <>
    <PageHeader title="Хронология" subtitle="Изменения документов, условий и шаблонов · связи с тендерами и задачами"/>
    <div className={styles.stack}>
      {projects.data?<HistoryProjectFilters projects={projectFilters} selected={selected} scope={scope} onSelect={selectSource}/>:projects.error?<ErrorState error={projects.error} onRetry={projects.reload}/>:null}
      <div className={styles.bar}>
        <label>Источники<select value={selected.length?'selected':scope} onChange={event=>selectSource(event.target.value)}>
          <option value="all">Все доступные источники</option>
          <option value="common">Общие условия и шаблоны</option>
          <option value="tenders">Только тендеры</option>
          {selected.length?<option value="selected" disabled>Выбранные проекты · {selected.length}</option>:null}
        </select></label>
        <label>Добавить проект<select value="" onChange={event=>{if(event.target.value)selectSource(event.target.value);}}>
          <option value="">Выберите проект</option>
          {items.filter(t=>!selected.includes(t.id)).map(t=><option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}
        </select></label>
        {selected.length?<Button variant="ghost" onClick={()=>selectSource('all')}>Сбросить выбор</Button>:null}
      </div>
      {unavailable.length?<Notice tone="warning">В выборе есть завершённые или недоступные проекты. Снимите их кнопками выше или сбросьте выбор.</Notice>:
        <TenderHistoryPanel key={JSON.stringify([selected,scope])} tender={tender} tenders={items} selectedIds={selected} scope={scope} sharedSummary={!selected.length&&scope==='all'?projects:undefined} onRefresh={!selected.length&&scope==='all'?undefined:projects.reload}/>}
    </div>
  </>;
};
