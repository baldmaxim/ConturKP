import type {FC} from 'react';
import {getHistoryVersions} from '../../api/historyEndpoints';
import {useApiResource} from '../../hooks/useApiResource';
import {ErrorState} from '../../components/ErrorState';
import {LoadingState} from '../../components/LoadingState';
import {historyDate} from './historyPresentation';
import styles from './TenderHistoryPanel.module.css';

export const HistoryFileFacts:FC<{recordId:string;occurredAt:string|null;kind:string}>=({recordId,occurredAt,kind})=>{
 const resource=useApiResource(signal=>getHistoryVersions(recordId,signal,true),recordId);
 if(resource.loading&&!resource.data)return <LoadingState/>;
 if(resource.error)return <ErrorState error={resource.error} onRetry={resource.reload}/>;
 if(!resource.data)return null;
 const removed=kind==='file_missing',restored=kind==='file_restored';
 const date=removed||restored?occurredAt:resource.data.after.modifiedAt??occurredAt;
 return <dl className={styles.changeFacts}>
  <div><dt>{removed?'Отсутствие обнаружено':restored?'Файл снова доступен':resource.data.after.modifiedAt?'Дата изменения':'Изменение обнаружено'}</dt><dd>{historyDate(date)}</dd></div>
  <div><dt>{removed?'Кем изменено':'Последний редактор'}</dt><dd>{resource.data.editor?.name??'Не определён'}{resource.data.editor?<span className={styles.factSource}>Из свойств документа</span>:null}</dd></div>
 </dl>;
};
