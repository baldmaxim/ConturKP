import type {FC} from 'react';
import type {HistoryScope,IHistoryChangedProject} from '../../api/historyEndpoints';
import {Button} from '../../components/Button';
import styles from './TenderHistoryPanel.module.css';

export const HistoryProjectFilters:FC<{projects:IHistoryChangedProject[];selected:string[];scope:HistoryScope;onSelect:(value:string)=>void}>=({projects,selected,scope,onSelect})=>
 <nav className={styles.quickProjects} aria-label="Быстрый фильтр изменённых проектов">
  <span className={styles.muted}>Проекты с изменениями{selected.length?' · выбрано: '+selected.length:' · можно выбрать несколько'}</span>
  <div className={styles.quickProjectButtons}>
   <Button variant={!selected.length&&scope==='all'?'primary':'secondary'} aria-pressed={!selected.length&&scope==='all'} onClick={()=>onSelect('all')}>Все изменения</Button>
   {projects.map(project=>{
    const value=project.tenderId??'common',active=project.tenderId?selected.includes(value):!selected.length&&scope==='common',label=project.tenderId?project.tenderCode+' · '+project.title:project.title;
    return <Button key={value} className={styles.quickProject} variant={active?'primary':'secondary'} aria-pressed={active} aria-label={label+' · событий: '+project.changes} title={label+' · всего событий: '+project.changes} onClick={()=>onSelect(value==='common'&&active?'all':value)}>
     <span className={styles.quickProjectName}>{active?<span aria-hidden="true">✓ </span>:null}{label}</span><span className={styles.quickProjectCount}>{project.changes.toLocaleString('ru-RU')}</span>
    </Button>;
   })}
  </div>
 </nav>;
