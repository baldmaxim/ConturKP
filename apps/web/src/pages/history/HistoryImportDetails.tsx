import type {FC} from 'react';
import {getImport} from '../../api/sourceEndpoints';
import {useApiResource} from '../../hooks/useApiResource';
import {ErrorState} from '../../components/ErrorState';
import styles from './TenderHistoryPanel.module.css';
const itemStatus:Record<string,string>={registered:'Принят',duplicate:'Уже был в портале',pending:'Обрабатывается',rejected:'Не принят',skipped_partial:'Пропущен'};
const batchStatus:Record<string,string>={running:'Идёт обработка',completed:'Обработка завершена',completed_with_errors:'Обработано с замечаниями',failed:'Ошибка обработки'};
export const HistoryImportDetails:FC<{id:string}>=({id})=>{
 const resource=useApiResource(signal=>getImport(id,signal),id);
 return <section className={styles.receiptDetails} aria-label="Поступившие документы"><h4>Состав поступления</h4>
  {resource.error?<ErrorState error={resource.error} onRetry={resource.reload}/>:null}
  {resource.loading&&!resource.data?<p className={styles.muted}>Загрузка состава…</p>:null}
  {resource.data?<>{resource.data.uploadName?<p>Загрузка: {resource.data.uploadName}</p>:null}<p className={styles.muted}>{resource.data.sourceKind==='watched_folder'?'Из сетевой папки':'Загружено через портал'} · {batchStatus[resource.data.status]}{resource.data.items.length?' · файлов: '+resource.data.items.length:''}</p>
   {resource.data.items.length?<ul className={styles.importFiles}>{resource.data.items.map(item=><li key={item.id}><span>{item.memberPath}</span><span>{itemStatus[item.status]??item.status}</span></li>)}</ul>:<p className={styles.muted}>{resource.data.expanded?'В загрузке нет отдельных документов.':'Состав загрузки ещё определяется.'}</p>}
  </>:null}
 </section>;
};
