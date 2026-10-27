interface IBackgroundSource {bindingId:string;enabled:boolean;lastErrorCode:string|null;lastSuccessAt:string|null}

export const historyDate=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Не указано';
export const historyTime=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'—';
export const historyDay=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(new Date(value)):'Дата не указана';
export const historyKinds:Record<string,string>={note:'Заметка',decision:'Решение из истории',mail:'Письмо',baseline:'Исходный снимок',changes:'Изменения файлов',call:'Звонок',dop:'Дополнение',folder_name:'Переименование папки',source_revision:'Редакция источника',import_compare:'Сравнение дополнения',import_accepted:'Поступление документов',document_revision_registered:'Новая редакция документа',source_set_changed:'Изменение входных документов',recognition_run_completed:'Распознавание завершено',calculation_revision_added:'Ревизия расчёта',communication_linked:'Связь с перепиской',transcript_revision_added:'Обновление расшифровки',qa_form_added:'Вопросы и ответы',decision_recorded:'Решение',draft_field_changed:'Изменение приложения',file_added:'Добавлен файл',file_modified:'Файл изменён',file_missing:'Файл пропал из папки',file_restored:'Файл снова доступен',file_content_changed:'Изменено содержимое файла',directory_baseline:'Исходная структура папок',directory_structure_changed:'Изменена структура папок'};
export const historyKind=(entry:{kind:string})=>historyKinds[entry.kind]??'Событие';
export const historySubject=(entry:{sourcePath:string|null;title:string})=>entry.sourcePath?.split(/[\\/]/).at(-1)||entry.title;
export const historySourceKey=(entry:{tenderId:string|null;folderName:string})=>(entry.tenderId??'common')+':'+entry.folderName;
export const historyBackground=(summary:{watch:IBackgroundSource[];sync:IBackgroundSource[]})=>{
 const failed=new Set([...summary.watch,...summary.sync].filter(s=>s.enabled&&s.lastErrorCode).map(s=>s.bindingId));
 const enabled=new Set([...summary.watch,...summary.sync].filter(s=>s.enabled).map(s=>s.bindingId));
 const successes=[...summary.watch,...summary.sync].filter(s=>s.enabled&&s.lastSuccessAt).map(s=>s.lastSuccessAt!).sort();
 return {enabled:enabled.size,failed:failed.size,lastSuccess:successes.at(-1)??null};
};

export const historyFileDescription=(kind:string)=>({file_added:'В папке появился новый файл.',file_modified:'Файл обновлён.',file_content_changed:'В документе обнаружены изменения.',file_missing:'Файл больше не доступен в папке.',file_restored:'Файл снова доступен в папке.'} as Record<string,string>)[kind]??'';
