import {useState,type FC} from 'react';
import {apiGet,API_BASE} from '../../api/client';
import {useApiResource} from '../../hooks/useApiResource';
import {Button} from '../../components/Button';
import {Notice} from '../../components/Notice';
import {LoadingState} from '../../components/LoadingState';
import {ErrorState} from '../../components/ErrorState';
import {formatDateTime} from '../../utils/datetime';
import styles from './ContractHistory.module.css';

interface IEntry {
 id:string;name:string;path:string;role:string;status:string;basis:string;
 documentDate:string|null;dateBasis:string|null;modifiedAt:string|null;observedAt:string;
 sizeBytes:string;signedHint:boolean;draftHint:boolean;notes:string;
 mainName:string|null;parentName:string|null;mainId:string|null;parentId:string|null;folder:string;
 locus:{method?:string;qualityStatus?:string;cacheAvailable?:boolean;ocrLimited?:boolean}|null;
}
interface IHistory {
 folders:{id:string;name:string;basis:string;observedAt:string;complete:boolean;files:number}[];
 counts:{files:number;review:number;mains:number;addenda:number;appendices:number};
 observations:{id:string;folder:string;observedAt:string;importedAt:string;complete:boolean;files:number}[];
 items:IEntry[];total:number;nextOffset:number|null;originalsAvailable:boolean;
}
const roles:Record<string,string>={main:'Основной договор',addendum:'Допсоглашение',appendix:'Приложение',act:'Акт',other:'Прочее'};
const date=(value:string|null):string=>value?value.split('-').reverse().join('.'):'Дата не установлена';
const bytes=(value:string):string=>Number(value)>=1e6?(Number(value)/1e6).toFixed(1)+' МБ':Number(value).toLocaleString('ru-RU')+' Б';

export const ContractHistoryPanel:FC<{contractId:string}>=({contractId})=>{
 const [q,setQ]=useState(''),[role,setRole]=useState(''),[review,setReview]=useState(false);
 const [offset,setOffset]=useState(0),[view,setView]=useState<'documents'|'observations'>('documents');
 const params=new URLSearchParams({q,role,review:String(review),offset:String(offset)});
 const resource=useApiResource(signal=>apiGet<IHistory>('/contracts/'+contractId+'/history?'+params.toString(),{signal}),contractId+':'+params.toString());
 const data=resource.data;
 if(resource.loading&&!data)return <LoadingState/>;
 if(resource.error)return <ErrorState error={resource.error} onRetry={resource.reload}/>;
 if(!data)return null;
 if(!data.folders.length)return <Notice tone="info">История сетевого архива к этому договору ещё не подключена.</Notice>;
 return <div className={styles.stack}>
  <div className={styles.summary} aria-label="Состав истории">
   <div><strong>{data.counts.files}</strong><span>файлов в архиве</span></div>
   <div><strong>{data.counts.addenda}</strong><span>допсоглашений и вариантов</span></div>
   <div><strong>{data.counts.appendices}</strong><span>приложений и вариантов</span></div>
   <div><strong>{data.counts.review}</strong><span>связи требуют проверки</span></div>
  </div>
  <Notice tone="info">Даты и признаки подписания из названий требуют подтверждения. Время изменения файла показано отдельно. Источник — текущие файлы сетевого архива; прежние байты этим реестром не закреплены.</Notice>
  <details className={styles.sources}><summary>Связанные папки · {data.folders.length}</summary>
   {data.folders.map(folder=><p key={folder.id}><strong>{folder.name}</strong><br/>{folder.basis}<br/><span className={styles.muted}>Наблюдение: {formatDateTime(folder.observedAt)} МСК · {folder.complete?'полный обход':'неполный обход'}</span></p>)}
  </details>
  <div className={styles.actions}>
   <Button variant={view==='documents'?'primary':'secondary'} onClick={()=>setView('documents')}>Хронология и связи документов</Button>
   <Button variant={view==='observations'?'primary':'secondary'} onClick={()=>setView('observations')}>Наблюдения архива</Button>
  </div>
  {view==='observations'?<ol className={styles.list} aria-label="Наблюдения архива">
   {data.observations.map(item=><li key={item.id} className={styles.entry}><strong>{formatDateTime(item.observedAt)} МСК</strong><p>{item.folder}</p><p>{item.files} файлов · {item.complete?'Полный обход':'Неполный обход'}</p><span className={styles.muted}>Внесено в портал: {formatDateTime(item.importedAt)} МСК. Это наблюдение файлов, а не дата подписания.</span></li>)}
  </ol>:<>
   <div className={styles.filters}>
    <label>Поиск<input type="search" value={q} maxLength={500} placeholder="Договор, номер ДС, название или путь" onChange={event=>{setQ(event.target.value);setOffset(0);}}/></label>
    <label>Вид документа<select value={role} onChange={event=>{setRole(event.target.value);setOffset(0);}}><option value="">Все виды</option>{Object.entries(roles).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
    <label className={styles.check}><input type="checkbox" checked={review} onChange={event=>{setReview(event.target.checked);setOffset(0);}}/>Связи на проверку</label>
   </div>
   <p className={styles.muted}>Найдено: {data.total}. Основной документ закреплён первым; остальные упорядочены по известной дате.</p>
   <ol className={styles.list} aria-label="Хронология документов">
    {data.items.map(item=><li key={item.id} className={styles.entry}>
     <div className={styles.entryHead}><span>{date(item.documentDate)}</span><span className={styles.role}>{roles[item.role]}</span></div>
     <strong className={styles.name}>{item.name}</strong>
     <p className={styles.path}>{item.path}</p>
     <div className={styles.tags}>
      <span className={item.status==='linked'?styles.linked:styles.review}>{item.status==='linked'?'Связь установлена':'Связь требует проверки'}</span>
      {item.signedHint?<span>«Подписано / ЭДО» в названии</span>:null}
      {item.draftHint?<span>Проект / редакция в пути</span>:null}
      {item.locus?.cacheAvailable?<span>Текст Locus найден</span>:null}
      {item.locus?.ocrLimited?<span className={styles.review}>Распознавание ограничено</span>:null}
     </div>
     {item.mainName?<p className={styles.relation}>Основной договор: {data.originalsAvailable&&item.mainId?<a href={API_BASE+'/contracts/'+contractId+'/history/files/'+item.mainId+'/original'} target="_blank" rel="noopener noreferrer">{item.mainName}</a>:item.mainName}</p>:null}
     {item.parentName&&item.parentId!==item.mainId?<p className={styles.relation}>Приложение к: {data.originalsAvailable&&item.parentId?<a href={API_BASE+'/contracts/'+contractId+'/history/files/'+item.parentId+'/original'} target="_blank" rel="noopener noreferrer">{item.parentName}</a>:item.parentName}</p>:null}
     <details><summary>Основание связи и даты</summary><dl className={styles.details}>
      <dt>Связь</dt><dd>{item.basis}</dd>
      {item.notes?<><dt>Примечание</dt><dd>{item.notes}</dd></>:null}
      <dt>Дата документа</dt><dd>{date(item.documentDate)} · {item.dateBasis==='document_header'?'по заголовку документа':'по названию; требует проверки'}</dd>
      <dt>Изменение файла</dt><dd>{formatDateTime(item.modifiedAt)} МСК</dd>
      <dt>Наблюдение</dt><dd>{formatDateTime(item.observedAt)} МСК</dd>
      <dt>Размер</dt><dd>{bytes(item.sizeBytes)}</dd>
     </dl></details>
     {data.originalsAvailable?(Number(item.sizeBytes)<=1024**3?<a className={styles.open} href={API_BASE+'/contracts/'+contractId+'/history/files/'+item.id+'/original'} target="_blank" rel="noopener noreferrer">Открыть текущий файл</a>:<span className={styles.muted}>Файл больше 1 ГБ — откройте его в сетевой папке.</span>):null}
    </li>)}
   </ol>
   {data.items.length===0?<Notice tone="info">По выбранным условиям документы не найдены.</Notice>:null}
   <div className={styles.actions}>
    <Button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>Предыдущие</Button>
    <span className={styles.muted}>{data.total?offset+1:0}–{Math.min(offset+50,data.total)} из {data.total}</span>
    <Button disabled={data.nextOffset===null} onClick={()=>setOffset(data.nextOffset??offset)}>Следующие</Button>
   </div>
  </>}
 </div>;
};
