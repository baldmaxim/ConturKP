import {useState,type FC} from 'react';
import {getHistoryContentComparison,historyVersionUrl,type IHistoryContentVersion} from '../../api/historyEndpoints';
import {useApiResource} from '../../hooks/useApiResource';
import {Button} from '../../components/Button';
import {ErrorState} from '../../components/ErrorState';
import {LoadingState} from '../../components/LoadingState';
import {PdfPreview} from '../release/PdfPreview';
import styles from './TenderHistoryPanel.module.css';

const Version:FC<{version:IHistoryContentVersion;recordId:string;side:'before'|'after'}>=({version,recordId,side})=><div className={styles.versionHead}>
 <strong>{side==='before'?'Было':'Стало'}</strong>
 {version.state==='absent'?<span>Файл отсутствовал</span>:!version.available?<span className={styles.error}>Копия этой версии не сохранена</span>:<><a href={historyVersionUrl(recordId,side)} download>Скачать эту версию</a></>}
</div>;

const Comparison:FC<{recordId:string}>=({recordId})=>{
 const resource=useApiResource(signal=>getHistoryContentComparison(recordId,signal),recordId),[visual,setVisual]=useState(false),[limit,setLimit]=useState(60);
 if(resource.loading&&!resource.data)return <LoadingState/>;
 if(resource.error)return <ErrorState error={resource.error} onRetry={resource.reload}/>;
 const data=resource.data!;
 return <div className={styles.stack}>
  <div className={styles.sectionHead}><h3>Изменения в документе</h3><Button variant="ghost" onClick={resource.reload}>Обновить изменения</Button></div>
  <div className={styles.diffHeads}><Version version={data.before} recordId={recordId} side="before"/><Version version={data.after} recordId={recordId} side="after"/></div>
  {data.status==='missing_versions'?<p className={styles.muted}>Для этого события не сохранились обе версии документа.</p>:null}
  {data.byteIdentical?<p>В содержимом документа изменений не найдено.</p>:data.status==='ready'&&!data.changes.length&&data.format!=='image'?<p>Текст документа не изменился. Изменения могут быть в оформлении или свойствах.</p>:null}
  {data.changes.length?<><p className={styles.muted}>{data.format==='cells'?'Ячейки':'Фрагменты'} · добавлено: {data.stats.added} · удалено: {data.stats.removed} · изменено: {data.stats.changed}</p><div className={styles.diffRows}>{data.changes.slice(0,limit).map((change,i)=><section key={i} className={styles.diffRow}><div className={styles.diffLocation}>{change.location}</div><div className={styles.diffColumns}><pre className={change.before===null?styles.diffEmpty:styles.diffBefore}>{change.before??'—'}</pre><pre className={change.after===null?styles.diffEmpty:styles.diffAfter}>{change.after??'—'}</pre></div></section>)}</div>{data.changes.length>limit?<Button onClick={()=>setLimit(limit+60)}>Показать ещё изменения</Button>:null}</>:null}
  {data.truncated?<p className={styles.error}>Показана часть изменений из-за объёма. Полные версии доступны для скачивания.</p>:null}
  {data.format==='image'?<div className={styles.diffImages}>{(['before','after'] as const).map(side=>data[side].state==='file'&&data[side].available?<figure key={side}><figcaption>{side==='before'?'До':'После'}</figcaption><img src={historyVersionUrl(recordId,side)} alt={side==='before'?'Сохранённое изображение до изменения':'Сохранённое изображение после изменения'}/></figure>:<div key={side}/>)}</div>:null}
  {data.format==='pdf'?<><Button onClick={()=>setVisual(!visual)} aria-expanded={visual}>{visual?'Скрыть страницы PDF':'Посмотреть страницы PDF до/после'}</Button>{visual?<div className={styles.diffImages}>{(['before','after'] as const).map(side=>data[side].state==='file'&&data[side].available?<PdfPreview key={side} url={historyVersionUrl(recordId,side)} title={side==='before'?'До изменения':'После изменения'}/>:<div key={side}/>)}</div>:null}</>:null}
  {data.warnings.length?<div className={styles.muted}>{data.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</div>:null}
 </div>;
};

export const HistoryContentComparison:FC<{recordId:string}>=({recordId})=>{
 const [open,setOpen]=useState(false);
 return <div className={styles.stack}><Button variant="secondary" onClick={()=>setOpen(!open)} aria-expanded={open}>{open?'Скрыть изменения в документе':'Что изменилось в документе'}</Button>{open?<Comparison recordId={recordId}/>:null}</div>;
};
