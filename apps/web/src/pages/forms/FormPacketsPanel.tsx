import { useEffect, useId, useState, type FC, type KeyboardEvent } from 'react';
import { apiGet, apiPost, apiPut, newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Icon, type TIconName } from '../../components/Icon';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import styles from './FormPacketsPanel.module.css';

interface Field {key:string;label:string;type:string;multiline?:boolean;options?:{value:string;label:string}[]}
interface Input {
 definition:{schema:{sections:{key:string;title:string;fields:Field[]}[]};recipes:Record<string,string>;recipeVariants?:Record<string,Record<string,string>>;outputs:{revisionId:string;name:string;mechanism?:string}[]};
 values:Record<string,string>;notes:string;calculationRevisionId:string|null;
 calculationInsurance?:{calculationRevisionId:string;amount:string;basis:string};
 performanceBond:{coveragePercent:string;annualRatePercent:string;months:string;addVat:boolean}|null;
 nominations:{key:string;title:string;amount:string;vatIncluded:boolean|null;vatRate:string;gpPercent:string}[];
 positions:{key:string;text:string;sourceId:string|null;confirmed:boolean}[];
 attachments:{sourceId:string;blankUnitPriceRows?:number[]}[];
}
interface Packet {
 id:string;title:string;etag:string;current_version_id:string|null;seq:number|null;based_on_id:string|null;input:Input|null;
 summary:Record<string,string>|null;calculationCheck:{reconciled:boolean;differenceDisplay:string;unexplainedDifferenceDisplay:string;insuranceAmount:string|null;insuranceDisplay:string|null;insuranceBasis:string|null}|null;
 sources:{id:string;name:string;blob_sha256:string;role:string;origin:string}[];
 history:{id:string;seq:number;changes:string[];created_at:string}[];
 builds:{id:string;version_id:string;issues:string[];created_at:string;files:{id:string;name:string;sha256:string}[]}[];
}
interface List {items:Packet[];canFill:boolean}
const TABS:{key:string;label:string;icon:TIconName}[]=[
 {key:'parameters',label:'Параметры',icon:'list-checks'},{key:'price',label:'Стоимость',icon:'calculator'},
 {key:'conditions',label:'Условия',icon:'scroll-text'},{key:'documents',label:'Документы',icon:'files'},
];
const HISTORY_LABELS:Record<string,string>={definition:'формулировки и шаблоны',positions:'позиция заказчика',attachments:'приложения',notes:'внутренние пометки',nominations:'номинированные стоимости',performanceBond:'банковская гарантия',calculationInsurance:'расшифровка страхования TenderHub'};
const dateLabel=(value:string):string=>new Date(value).toLocaleString('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
export const FormPacketsPanel:FC<{stageId:string}>=({stageId})=>{
 const resource=useApiResource(signal=>apiGet<List>(`/stages/${stageId}/form-packets`,{signal}),stageId);
 const uid=useId();
 const [selected,setSelected]=useState('');
 const [tab,setTab]=useState('parameters');
 const [input,setInput]=useState<Input|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [dirty,setDirty]=useState(false);
 const packet=resource.data?.items.find(p=>p.id===selected)??resource.data?.items[0];
 useEffect(()=>{setInput(packet?.input?structuredClone(packet.input):null);setDirty(false);},[packet?.id,packet?.current_version_id]);
 if(resource.loading&&!resource.data)return null;
 if(resource.error)return <p role="alert">{describeError(resource.error)}</p>;
 if(!packet)return null;
 const fields=input?.definition.schema.sections.flatMap(s=>s.fields)??[];
 const labels=new Map(fields.map(f=>[f.key,f.label]));
 const change=(next:Input):void=>{setInput(next);setDirty(true);};
 const editable=Boolean(resource.data?.canFill)&&!busy;
 const run=async(action:()=>Promise<void>):Promise<void>=>{
  setBusy(true);setError('');try{await action();resource.reload();}catch(e){setError(describeError(e));}finally{setBusy(false);}
 };
 const save=async():Promise<Packet>=>{
  if(!input)throw new Error('Нет параметров');
  if(!dirty)return packet;
  const p=await apiPut<Packet>(`/form-packets/${packet.id}`,{body:input,ifMatch:packet.etag});setDirty(false);return p;
 };
 const latest=packet.builds[0];
 const stale=Boolean(latest&&(latest.version_id!==packet.current_version_id||dirty));
 const humanRecipe=(text:string):string=>text.replace(/\[\[([a-z][a-z0-9_]{0,63})\]\]/gu,(_match,k:string)=>`«${labels.get(k)??k}»`);
 const storedRecipe=(text:string):string=>{let result=text;for(const[k,label]of labels)result=result.split(`«${label}»`).join(`[[${k}]]`);return result;};
 const fieldControl=(f:Field)=>{
  if(!input)return null;
  const update=(value:string):void=>change({...input,values:{...input.values,[f.key]:value}});
  return <div key={f.key} className={f.multiline?styles.fullWidth:undefined}>
   {f.type==='choice'?<SelectField label={f.label} value={input.values[f.key]??''} disabled={!editable} options={[{value:'',label:'Не выбрано'},...f.options??[]]} onValueChange={update}/>
    :f.multiline?<TextAreaField label={f.label} rows={3} value={input.values[f.key]??''} disabled={!editable} onValueChange={update}/>
     :<TextField label={f.label} type={f.type==='date'?'date':'text'} inputMode={f.type==='number'?'decimal':undefined} disabled={!editable} readOnly={f.key==='th_total'&&Boolean(input.calculationRevisionId)} hint={f.key==='th_total'&&input.calculationRevisionId?'Из закреплённого расчёта TenderHub':undefined} value={input.values[f.key]??''} onValueChange={update}/>}
  </div>;
 };
 const navigateTabs=(event:KeyboardEvent<HTMLButtonElement>,index:number):void=>{
  let next:number;
  if(event.key==='ArrowRight')next=(index+1)%TABS.length;
  else if(event.key==='ArrowLeft')next=(index+TABS.length-1)%TABS.length;
  else if(event.key==='Home')next=0;
  else if(event.key==='End')next=TABS.length-1;
  else return;
  event.preventDefault();setTab(TABS[next]!.key);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
 };
 const files=latest?.files??[];
 const previewFiles=files.filter(f=>/\.pdf$/iu.test(f.name)).slice(0,3);
 const attachments=packet.sources.filter(s=>s.role==='attachment');
 const referenceSources=packet.sources.filter(s=>s.role!=='attachment');
 return <section className={styles.panel} aria-labelledby={`${uid}-title`}>
  <header className={styles.header}>
   <div><div className={styles.eyebrow}>Проверка владельцем</div><div className={styles.titleRow}><h3 id={`${uid}-title`}>Комплект КП</h3><Badge label="Черновик" icon="pencil" tone="muted"/></div><p className={styles.description}>Одна подача — согласованные параметры, условия и документы.</p></div>
   <div className={styles.submission}><SelectField label="Подача" value={packet.id} disabled={busy||dirty} onValueChange={setSelected} options={resource.data?.items.map(p=>({value:p.id,label:p.title}))??[]}/><span className={styles.caption}>Версия {packet.seq??'—'}{latest?` · сборка ${dateLabel(latest.created_at)}`:''}</span></div>
  </header>
  {input?<>
   <div className={styles.workspace}>
    <div className={styles.editor}>
     <div className={styles.tabs} role="tablist" aria-label="Разделы комплекта КП">{TABS.map((item,index)=><button key={item.key} type="button" role="tab" id={`${uid}-${item.key}`} aria-selected={tab===item.key} aria-controls={`${uid}-content`} tabIndex={tab===item.key?0:-1} onKeyDown={event=>navigateTabs(event,index)} onClick={()=>setTab(item.key)} className={styles.tab}><Icon name={item.icon} size={16}/><span>{item.label}</span></button>)}</div>
     <div className={styles.content} role="tabpanel" id={`${uid}-content`} aria-labelledby={`${uid}-${tab}`} tabIndex={0}>
      {tab==='parameters'?<>
       <div className={styles.sectionHeading}><h4>Параметры подачи</h4><p>Значения автоматически подставляются в условия, письмо и методику.</p></div>
       {input.definition.schema.sections.map((section,index)=><details className={styles.accordion} key={section.key} open={section.key==='identity'||section.key==='parameters'||index===0}><summary><span>{section.title}</span><span className={styles.summaryEnd}>{section.fields.length}<Icon name="chevron-down" size={16}/></span></summary><div className={styles.accordionBody}><div className={styles.fieldGrid}>{section.fields.map(fieldControl)}</div></div></details>)}
      </>:null}
      {tab==='price'?<>
       <div className={styles.sectionHeading}><h4>Стоимость и обеспечение</h4><p>Номинированные разделы дополняют расчёт TenderHub. Итог обновляется после сохранения.</p></div>
       {input.calculationRevisionId?<section className={styles.bond}><div className={styles.subheading}><h5>Страхование в итоге TenderHub</h5></div>
        <label className={styles.check}><input type="checkbox" disabled={!editable} checked={Boolean(input.calculationInsurance)} onChange={e=>{const next={...input};if(e.target.checked)next.calculationInsurance={calculationRevisionId:input.calculationRevisionId!,amount:'',basis:''};else delete next.calculationInsurance;change(next);}}/><span>Сохранить расшифровку страхования</span></label>
        {input.calculationInsurance?<><TextField label="Страхование, ₽" inputMode="decimal" disabled={!editable} value={input.calculationInsurance.amount} onValueChange={amount=>change({...input,calculationInsurance:{...input.calculationInsurance!,amount}})}/><TextAreaField label="Основание расшифровки" rows={3} disabled={!editable} value={input.calculationInsurance.basis} onValueChange={basis=>change({...input,calculationInsurance:{...input.calculationInsurance!,basis}})}/><p className={styles.caption}>Страхование уже входит в итог TenderHub. Расшифровка используется для сверки этой ревизии и сохраняется в истории подачи.</p></>:null}
       </section>:null}
       <div className={styles.subheading}><h5>Номинированные разделы</h5><span className={styles.count}>{input.nominations.length}</span></div>
       <div className={styles.cardList}>{input.nominations.map((row,index)=>{
        const edit=(patch:Partial<typeof row>):void=>{const nominations=[...input.nominations];nominations[index]={...row,...patch};change({...input,nominations});};
        return <section key={row.key} className={styles.nomination} aria-label={`Номинированный раздел ${index+1}`}><span className={styles.itemNumber}>Раздел {String(index+1).padStart(2,'0')}</span>
         <TextAreaField label="Название раздела" rows={2} disabled={!editable} value={row.title} onValueChange={value=>edit({title:value})}/>
         <div className={styles.fieldGrid}>
          <TextField label="Стоимость, ₽" inputMode="decimal" disabled={!editable} value={row.amount} onValueChange={value=>edit({amount:value})}/>
          <SelectField label="База НДС" disabled={!editable} value={row.vatIncluded===null?'unknown':row.vatIncluded?'included':'excluded'} options={[{value:'unknown',label:'Не определена'},{value:'included',label:'Сумма с НДС'},{value:'excluded',label:'Сумма без НДС'}]} onValueChange={value=>edit({vatIncluded:value==='unknown'?null:value==='included'})}/>
          <TextField label="НДС, %" inputMode="decimal" disabled={!editable} value={row.vatRate} onValueChange={value=>edit({vatRate:value})}/>
          <TextField label="Генподряд, %" inputMode="decimal" disabled={!editable} value={row.gpPercent} onValueChange={value=>edit({gpPercent:value})}/>
         </div>
        </section>;
       })}</div>
       <Button className={styles.addButton} icon="plus" variant="ghost" disabled={!editable} onClick={()=>change({...input,nominations:[...input.nominations,{key:`n${newUuid().replace(/-/gu,'').slice(0,12)}`,title:'Новый раздел',amount:'',vatIncluded:null,vatRate:input.values.vat_rate??'',gpPercent:''}]})}>Добавить раздел</Button>
       <section className={styles.bond}><div className={styles.subheading}><h5>Банковская гарантия</h5><Icon name="file-signature" size={20}/></div>
        <label className={styles.check}><input type="checkbox" disabled={!editable} checked={Boolean(input.performanceBond)} onChange={e=>change({...input,performanceBond:e.target.checked?{coveragePercent:'3',annualRatePercent:'3',months:input.values.c09_months_to_zos??'30',addVat:true}:null})}/><span>БГ на исполнение контракта</span></label>
        {input.performanceBond?<><div className={styles.fieldGrid}>
         <TextField label="Обеспечение от цены договора, %" inputMode="decimal" disabled={!editable} value={input.performanceBond.coveragePercent} onValueChange={value=>change({...input,performanceBond:{...input.performanceBond!,coveragePercent:value}})}/>
         <TextField label="Комиссия банка, % годовых" inputMode="decimal" disabled={!editable} value={input.performanceBond.annualRatePercent} onValueChange={value=>change({...input,performanceBond:{...input.performanceBond!,annualRatePercent:value}})}/>
         <TextField label="Срок, мес." inputMode="decimal" disabled={!editable} readOnly={Boolean(input.values.c09_months_to_zos)} hint={input.values.c09_months_to_zos?'Из срока строительства в параметрах':undefined} value={input.values.c09_months_to_zos??input.performanceBond.months} onValueChange={value=>change({...input,performanceBond:{...input.performanceBond!,months:value}})}/>
        </div><label className={styles.check}><input type="checkbox" disabled={!editable} checked={input.performanceBond.addVat} onChange={e=>change({...input,performanceBond:{...input.performanceBond!,addVat:e.target.checked}})}/><span>Прибавка к цене с НДС КП, без генподрядной надбавки</span></label><p className={styles.caption}>БГ рассчитывается от полной цены с её стоимостью. Расчёт предварительный до подтверждения банка.</p></>:null}
       </section>
      </>:null}
      {tab==='conditions'?<>
       <div className={styles.sectionHeading}><h4>Условия и формулировки</h4><p>Значения в «кавычках» связаны с параметрами подачи. Сохраняйте нужные подстановки при редактировании текста.</p></div>
       {Object.entries({...input.definition.recipes,...input.definition.recipeVariants?.[input.values.c08_mechanism??'']}).map(([key,text])=>{
        const title=/^c\d{2}_proposal$/u.test(key)?`Пункт ${key.slice(1,3)}`:key==='letter_extras'?'Дополнительные условия письма':key;
        return <details key={key} className={styles.clause}><summary><div><span className={styles.clauseTitle}>{title}</span><span className={styles.preview}>{humanRecipe(text)||'Формулировка не заполнена'}</span></div><Icon name="chevron-down" size={16}/></summary><div className={styles.accordionBody}>
         <TextAreaField label={title} rows={6} disabled={!editable} value={humanRecipe(text)} onValueChange={value=>{
          const mechanism=input.values.c08_mechanism??'',variants=input.definition.recipeVariants??{};
          if(variants[mechanism]&&key in variants[mechanism])change({...input,definition:{...input.definition,recipeVariants:{...variants,[mechanism]:{...variants[mechanism],[key]:storedRecipe(value)}}}});
          else change({...input,definition:{...input.definition,recipes:{...input.definition.recipes,[key]:storedRecipe(value)}}});
         }}/>
        </div></details>;
       })}
       <details className={styles.accordion}><summary><span>Позиция заказчика</span><span className={styles.summaryEnd}>{input.positions.filter(p=>p.confirmed).length} из {input.positions.length}<Icon name="chevron-down" size={16}/></span></summary><div className={styles.accordionBody}>
        <p className={styles.caption}>В документы попадает только подтверждённый ответ с источником. Внутренние пометки ведутся отдельно.</p>
        {input.positions.map((p,index)=>{
         const edit=(patch:Partial<typeof p>):void=>{const positions=[...input.positions];positions[index]={...p,...patch};change({...input,positions});};
         return <details key={p.key} className={styles.clause}><summary><span>Пункт {Number(p.key.slice(1,3))}</span><span className={styles.summaryEnd}>{p.confirmed?'Подтверждён':p.text?'Черновик':'Нет ответа'}<Icon name="chevron-down" size={16}/></span></summary><div className={styles.accordionBody}>
          <TextAreaField label="Ответ заказчика" rows={3} disabled={!editable} value={p.text} onValueChange={value=>edit({text:value})}/>
          <SelectField label="Источник ответа" disabled={!editable} value={p.sourceId??''} options={[{value:'',label:'Не выбран'},...packet.sources.map(s=>({value:s.id,label:s.name}))]} onValueChange={value=>edit({sourceId:value||null,confirmed:false})}/>
          <label className={styles.check}><input type="checkbox" disabled={!editable||!p.sourceId} checked={p.confirmed} onChange={e=>edit({confirmed:e.target.checked})}/><span>Подтверждено ответом заказчика</span></label>
         </div></details>;
        })}
       </div></details>
       <section className={styles.notes}><TextAreaField label="Внутренние пометки команды" hint="Сохраняются в истории подачи и не входят в документы." rows={4} disabled={!editable} value={input.notes} onValueChange={value=>change({...input,notes:value})}/></section>
      </>:null}
      {tab==='documents'?<>
       <div className={styles.sectionHeading}><h4>Документы комплекта</h4><p>Собранные формы и закреплённые версии приложений этой подачи.</p></div>
       {stale?<p className={styles.notice} role="status"><Icon name="info" size={16}/><span>Условия изменились. Соберите черновик заново, чтобы обновить документы.</span></p>:null}
       {latest?<div className={styles.fileList}>{files.map(f=><a className={styles.file} key={f.id} href={`/api/v1/form-packet-files/${f.id}`} target="_blank" rel="noreferrer"><Icon name="files" size={20}/><span>{f.name}<small>{/\.pdf$/iu.test(f.name)?'PDF · для просмотра':'Файл комплекта'}</small></span><Icon name="download" size={16}/></a>)}</div>:<p className={styles.caption}>Документы появятся после первой сборки черновика.</p>}
       <div className={styles.subheading}><h5>Приложения подачи</h5><span className={styles.count}>{input.attachments.length}</span></div><p className={styles.caption}>Отметьте файлы, которые должны войти в комплект.</p>
       <div className={styles.attachmentList}>{attachments.map(s=><label className={styles.check} key={s.id}><input type="checkbox" disabled={!editable} checked={input.attachments.some(a=>a.sourceId===s.id)} onChange={e=>change({...input,attachments:e.target.checked?[...input.attachments,{sourceId:s.id}]:input.attachments.filter(a=>a.sourceId!==s.id)})}/><span>{s.name}</span></label>)}</div>
       <details className={styles.accordion}><summary><span>Исходники для сверки</span><span className={styles.summaryEnd}>{referenceSources.length}<Icon name="chevron-down" size={16}/></span></summary><div className={styles.accordionBody}>{referenceSources.map(s=><div key={s.id} className={styles.source}><a href={`/api/v1/form-packet-sources/${s.id}`} target="_blank" rel="noreferrer">{s.name}<Icon name="external-link" size={16}/></a><span className={styles.caption}>{s.role==='internal'?'Внутренний документ':'Источник'}</span>{s.origin?<details className={styles.origin}><summary>Расположение источника</summary><p>{s.origin}</p></details>:null}</div>)}</div></details>
      </>:null}
     </div>
    </div>
    <aside className={styles.sidebar} aria-label="Итоги и проверка комплекта">
     {packet.summary?<section className={styles.totalCard}><span className={styles.eyebrow}>Итог КП{dirty?' · до изменений':''}</span><div className={styles.total}>{packet.summary.kp_total}<span>₽</span></div><span className={styles.caption}>Включая номинированные разделы и стоимость БГ</span>
      <dl className={styles.breakdown}>{[['th_total','Расчёт TenderHub'],['nomination_total','Номинации с генподрядом'],['performance_bond_price_addition','Стоимость БГ с НДС']].map(([key,label])=>packet.summary?.[key!]?<div key={key}><dt>{label}</dt><dd>{packet.summary[key!]} ₽</dd></div>:null)}<div className={styles.vat}><dt>В том числе НДС</dt><dd>{packet.summary.vat_amount} ₽</dd></div></dl>
      {packet.summary.performance_bond_amount?<details className={styles.bondDetails}><summary>Расчёт банковской гарантии<Icon name="chevron-down" size={16}/></summary><dl className={styles.breakdown}><div><dt>Сумма обеспечения</dt><dd>{packet.summary.performance_bond_amount} ₽</dd></div><div><dt>Комиссия банка</dt><dd>{packet.summary.performance_bond_bank_fee} ₽</dd></div></dl><p className={styles.caption}>Обеспечение не прибавляется к цене КП.</p></details>:null}
      {dirty?<p className={styles.dirtyHint} role="status">Сохраните изменения, чтобы пересчитать итог.</p>:null}
     </section>:null}
     {packet.calculationCheck?.insuranceAmount!==null&&packet.calculationCheck?.insuranceAmount!==undefined?<section className={styles.sideSection}><h5>Страхование в итоге TenderHub</h5><p>{packet.calculationCheck.insuranceDisplay} ₽ · включено в расчёт</p><p className={styles.caption}>{packet.calculationCheck.insuranceBasis}</p>{packet.calculationCheck.reconciled?<p className={styles.caption}>Сумма позиций и страхование совпадают с итогом TenderHub.</p>:null}</section>:null}
     {packet.calculationCheck&&!packet.calculationCheck.reconciled?<div className={styles.notice}><Icon name="info" size={16}/><div><strong>Требуется сверка цены</strong><p>Нерасшифрованный остаток итога TenderHub: {packet.calculationCheck.unexplainedDifferenceDisplay} ₽. Нужна расшифровка дополнительных начислений; итог пока проверочный.</p></div></div>:null}
     {latest?<section className={styles.sideSection}><div className={styles.subheading}><h5>Готовый черновик</h5><span className={styles.count}>{files.length}</span></div><p className={styles.caption}>{stale?'Требуется новая сборка':`Собран ${dateLabel(latest.created_at)}`}</p>
      {previewFiles.map(f=><a key={f.id} className={styles.previewFile} href={`/api/v1/form-packet-files/${f.id}`} target="_blank" rel="noreferrer"><span className={styles.fileType}>PDF</span><span>{f.name.replace(/\.pdf$/iu,'')}</span><Icon name="external-link" size={16}/></a>)}
      <Button variant="ghost" className={styles.allFiles} icon="folder" onClick={()=>setTab('documents')}>Все файлы комплекта</Button>
     </section>:null}
     {latest?.issues.length?<details className={styles.reviewIssues}><summary><Icon name="list-checks" size={16}/><span>Что требует проверки</span><span className={styles.count}>{latest.issues.length}</span><Icon name="chevron-down" size={16}/></summary><ul>{latest.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></details>:null}
    </aside>
   </div>
   {error?<p className={styles.error} role="alert"><Icon name="circle-x" size={16}/>{error}</p>:null}
   <footer className={styles.actions}><span className={styles.saveStatus} role="status"><Icon name={dirty?'pencil':'check'} size={16}/>{busy?'Выполняется…':dirty?'Есть изменения':`Версия ${packet.seq??'—'} сохранена`}</span><div className={styles.actionButtons}>
    <Button variant="ghost" icon="copy" disabled={!editable||dirty} onClick={()=>void run(async()=>{const p=await apiPost<Packet>(`/stages/${stageId}/form-packets`,{body:{title:`${packet.title} — новая подача`,basedOnId:packet.id},idempotencyKey:newUuid()});setSelected(p.id);})}>Новая подача</Button>
    <Button disabled={!editable||!dirty} onClick={()=>void run(async()=>{await save();})}>Сохранить</Button>
    <Button className={styles.buildButton} variant="primary" icon="files" loading={busy} disabled={!editable} onClick={()=>void run(async()=>{const p=await save();await apiPost(`/form-packets/${p.id}/build`,{body:{previewPdf:true},ifMatch:p.etag,idempotencyKey:newUuid()});})}>Собрать черновик</Button>
   </div></footer>
  </>:<p className={styles.empty}>Шаблоны комплекта готовятся.</p>}
  <details className={styles.history}><summary><Icon name="layers" size={16}/><span>История подачи</span><Icon name="chevron-down" size={16}/></summary><div className={styles.historyBody}>
   {packet.history.map(v=><div key={v.id} className={styles.historyItem}><strong>Версия {v.seq}</strong><span className={styles.caption}>{dateLabel(v.created_at)}</span><p>{v.changes.map(k=>labels.get(k)??HISTORY_LABELS[k]??k).join(', ')}</p></div>)}
   {packet.builds.slice(1).map(b=><details className={styles.accordion} key={b.id}><summary><span>Черновик от {dateLabel(b.created_at)}</span><Icon name="chevron-down" size={16}/></summary><div className={styles.accordionBody}>{b.files.map(f=><a key={f.id} href={`/api/v1/form-packet-files/${f.id}`} target="_blank" rel="noreferrer">{f.name}</a>)}</div></details>)}
  </div></details>
 </section>;
};
