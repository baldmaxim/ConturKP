import { useEffect, useState, type FC } from 'react';
import { apiGet, apiPost, apiPut, newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { useApiResource } from '../../hooks/useApiResource';
import form from '../../styles/form.module.css';
import styles from './Forms.module.css';

interface Field {key:string;label:string;type:string;multiline?:boolean;options?:{value:string;label:string}[]}
interface Input {
  definition:{schema:{sections:{key:string;title:string;fields:Field[]}[]};recipes:Record<string,string>;recipeVariants?:Record<string,Record<string,string>>;outputs:{revisionId:string;name:string;mechanism?:string}[]};
  values:Record<string,string>;notes:string;
  calculationRevisionId:string|null;
  nominations:{key:string;title:string;amount:string;vatIncluded:boolean|null;vatRate:string;gpPercent:string}[];
  positions:{key:string;text:string;sourceId:string|null;confirmed:boolean}[];
  attachments:{sourceId:string;blankUnitPriceRows?:number[]}[];
}
interface Packet {
 id:string;title:string;etag:string;current_version_id:string|null;seq:number|null;based_on_id:string|null;input:Input|null;
 summary:Record<string,string>|null;
 calculationCheck:{reconciled:boolean;differenceDisplay:string}|null;
 sources:{id:string;name:string;blob_sha256:string;role:string;origin:string}[];
 history:{id:string;seq:number;changes:string[];created_at:string}[];
 builds:{id:string;version_id:string;issues:string[];created_at:string;files:{id:string;name:string;sha256:string}[]}[];
}
interface List {items:Packet[];canFill:boolean}
export const FormPacketsPanel:FC<{stageId:string}>=({stageId})=>{
 const resource=useApiResource(signal=>apiGet<List>(`/stages/${stageId}/form-packets`,{signal}),stageId);
 const [selected,setSelected]=useState('');
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
  const p=await apiPut<Packet>(`/form-packets/${packet.id}`,{body:input,ifMatch:packet.etag});
  setDirty(false);return p;
 };
 const latest=packet.builds[0];
 const humanRecipe=(text:string)=>text.replace(/\[\[([a-z][a-z0-9_]{0,63})\]\]/gu,(_match,k:string)=>`«${labels.get(k)??k}»`);
 const storedRecipe=(text:string)=>{
  let result=text;for(const [k,label]of labels)result=result.split(`«${label}»`).join(`[[${k}]]`);return result;
 };
 return <section className={form.section} aria-labelledby="form-packet-title">
  <h3 id="form-packet-title">Комплект КП — проверка владельцем</h3>
  <p className={styles.muted}>Условия, письмо и методика используют одни параметры подачи. Черновик ожидает проверки и согласования.</p>
  {packet.calculationCheck&&!packet.calculationCheck.reconciled?<p role="alert">Цена требует проверки: шапка TenderHub расходится с суммой позиций на {packet.calculationCheck.differenceDisplay} ₽. Итог комплекта пока проверочный.</p>:null}
  <label className={form.stack}>Подача<select value={packet.id} onChange={e=>setSelected(e.target.value)} disabled={busy||dirty}>
   {resource.data?.items.map(p=><option key={p.id} value={p.id}>{p.title} · версия {p.seq??'—'}</option>)}
  </select></label>
  {input?<div className={form.stack}>
   {input.definition.schema.sections.map(section=><details key={section.key} open={section.key==='parameters'||section.key==='identity'}>
    <summary>{section.title}</summary><div className={form.stack}>
     {section.fields.map(f=><label className={form.stack} key={f.key}>{f.label}
      {f.type==='choice'?<select disabled={!editable} value={input.values[f.key]??''} onChange={e=>change({...input,values:{...input.values,[f.key]:e.target.value}})}>
       <option value="">Не выбрано</option>{f.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>:f.multiline?<textarea rows={3} disabled={!editable} value={input.values[f.key]??''} onChange={e=>change({...input,values:{...input.values,[f.key]:e.target.value}})}/>
       :<input type={f.type==='date'?'date':'text'} inputMode={f.type==='number'?'decimal':undefined} disabled={!editable||(f.key==='th_total'&&Boolean(input.calculationRevisionId))} value={input.values[f.key]??''} onChange={e=>change({...input,values:{...input.values,[f.key]:e.target.value}})}/>}
     </label>)}
    </div>
   </details>)}
   <details open><summary>Номинированные стоимости</summary><div className={form.stack}>
    <p className={styles.muted}>Эти стоимости добавляются к расчёту TenderHub. Укажите базу НДС и вознаграждение генподрядчика для каждой строки.</p>
    {input.nominations.map((row,i)=>{
     const edit=(patch:Partial<typeof row>):void=>{const nominations=[...input.nominations];nominations[i]={...row,...patch};change({...input,nominations});};
     return <div key={row.key} className={form.stack}>
      <label>Раздел<input disabled={!editable} value={row.title} onChange={e=>edit({title:e.target.value})}/></label>
      <label>Стоимость, руб.<input inputMode="decimal" disabled={!editable} value={row.amount} onChange={e=>edit({amount:e.target.value})}/></label>
      <label>База НДС<select disabled={!editable} value={row.vatIncluded===null?'unknown':row.vatIncluded?'included':'excluded'} onChange={e=>edit({vatIncluded:e.target.value==='unknown'?null:e.target.value==='included'})}><option value="unknown">Не определена</option><option value="included">Сумма включает НДС</option><option value="excluded">Сумма без НДС</option></select></label>
      <label>Ставка НДС, %<input inputMode="decimal" disabled={!editable} value={row.vatRate} onChange={e=>edit({vatRate:e.target.value})}/></label>
      <label>Генподрядный процент, %<input inputMode="decimal" disabled={!editable} value={row.gpPercent} onChange={e=>edit({gpPercent:e.target.value})}/></label>
     </div>;
    })}
    <Button disabled={!editable} onClick={()=>change({...input,nominations:[...input.nominations,{key:`n${newUuid().replace(/-/gu,'').slice(0,12)}`,title:'Новый раздел',amount:'',vatIncluded:null,vatRate:input.values.vat_rate??'',gpPercent:''}]})}>Добавить номинированный раздел</Button>
    {packet.summary?<dl>{Object.entries(packet.summary).map(([k,v])=><div key={k}><dt>{{th_total:'Расчёт TenderHub',nomination_total:'Номинированные разделы с генподрядом',kp_total:'Итог КП',vat_amount:'В том числе НДС'}[k]??k}</dt><dd>{v} ₽</dd></div>)}</dl>:null}
    {dirty?<p className={styles.muted}>Состав итога обновится после сохранения изменений.</p>:null}
   </div></details>
   <details><summary>Формулировки условий и письма</summary>
    <p className={styles.muted}>Значения в угловых кавычках подставляются из параметров подачи. Меняйте окружающий текст, сохраняя нужные подстановки.</p>
    <div className={form.stack}>{Object.entries({...input.definition.recipes,...input.definition.recipeVariants?.[input.values.c08_mechanism??'']}).map(([key,text])=><label className={form.stack} key={key}>
      {/^c\d{2}_proposal$/u.test(key)?`Условие ${Number(key.slice(1,3))}`:key==='letter_extras'?'Дополнительные условия письма':key}
      <textarea rows={5} disabled={!editable} value={humanRecipe(text)} onChange={e=>{
       const mechanism=input.values.c08_mechanism??'';
       const variants=input.definition.recipeVariants??{};
       if(variants[mechanism]&&key in variants[mechanism]) change({...input,definition:{...input.definition,recipeVariants:{...variants,[mechanism]:{...variants[mechanism],[key]:storedRecipe(e.target.value)}}}});
       else change({...input,definition:{...input.definition,recipes:{...input.definition.recipes,[key]:storedRecipe(e.target.value)}}});
      }}/>
    </label>)}</div>
   </details>
   <details><summary>Позиция заказчика и её источники</summary><div className={form.stack}>
    <p className={styles.muted}>В документы попадает только подтверждённый ответ с указанным источником. Пометки команды ведутся отдельно ниже.</p>
    {input.positions.map((p,i)=><div key={p.key} className={form.stack}>
     <label>Пункт {Number(p.key.slice(1,3))}<textarea rows={2} disabled={!editable} value={p.text} onChange={e=>{const positions=[...input.positions];positions[i]={...p,text:e.target.value};change({...input,positions});}}/></label>
     <label>Источник<select disabled={!editable} value={p.sourceId??''} onChange={e=>{const positions=[...input.positions];positions[i]={...p,sourceId:e.target.value||null,confirmed:false};change({...input,positions});}}>
      <option value="">Не выбран</option>{packet.sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
     </select></label>
     <label><input type="checkbox" disabled={!editable||!p.sourceId} checked={p.confirmed} onChange={e=>{const positions=[...input.positions];positions[i]={...p,confirmed:e.target.checked};change({...input,positions});}}/> Подтверждено ответом заказчика</label>
    </div>)}
   </div></details>
   <details><summary>Приложения текущей подачи</summary><div className={form.stack}>
    {packet.sources.filter(s=>s.role==='attachment').map(s=><label key={s.id}><input type="checkbox" disabled={!editable} checked={input.attachments.some(a=>a.sourceId===s.id)} onChange={e=>change({...input,attachments:e.target.checked?[...input.attachments,{sourceId:s.id}]:input.attachments.filter(a=>a.sourceId!==s.id)})}/> {s.name}</label>)}
    <h4>Исходники для сверки</h4><ul>{packet.sources.filter(s=>s.role!=='attachment').map(s=><li key={s.id}><a href={`/api/v1/form-packet-sources/${s.id}`} target="_blank" rel="noreferrer">{s.name}</a> · {s.role==='internal'?'внутренний':'источник'}{s.origin?<p className={styles.muted}>{s.origin}</p>:null}</li>)}</ul>
   </div></details>
   <label className={form.stack}>Внутренние пометки команды — не входят в документы<textarea rows={4} disabled={!editable} value={input.notes} onChange={e=>change({...input,notes:e.target.value})}/></label>
   <div className={styles.row}>
    <Button disabled={!editable||!dirty} onClick={()=>void run(async()=>{await save();})}>Сохранить изменения</Button>
    <Button variant="primary" loading={busy} disabled={!editable} onClick={()=>void run(async()=>{
     const p=await save();await apiPost(`/form-packets/${p.id}/build`,{body:{previewPdf:true},ifMatch:p.etag,idempotencyKey:newUuid()});
    })}>Собрать черновик для проверки</Button>
    <Button disabled={!editable||dirty} onClick={()=>void run(async()=>{
     const p=await apiPost<Packet>(`/stages/${stageId}/form-packets`,{body:{title:`${packet.title} — новая подача`,basedOnId:packet.id},idempotencyKey:newUuid()});setSelected(p.id);
    })}>Новая подача из этих условий</Button>
   </div>
  </div>:<p>Шаблоны комплекта готовятся.</p>}
  {error?<p role="alert">{error}</p>:null}
  {latest?<div className={form.stack}>
   <h4>Собранный черновик</h4>
   {latest.version_id!==packet.current_version_id||dirty?<p role="status">Параметры изменились после сборки. Для просмотра текущих условий соберите новый черновик.</p>:null}
   <ul>{latest.files.map(f=><li key={f.id}><a href={`/api/v1/form-packet-files/${f.id}`} target="_blank" rel="noreferrer">{f.name}</a></li>)}</ul>
   <details><summary>Что требует проверки</summary><ul>{latest.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></details>
  </div>:null}
  <details><summary>История условий и собранных версий</summary>
   <ul>{packet.history.map(v=><li key={v.id}>Версия {v.seq} · {new Date(v.created_at).toLocaleString('ru-RU')} · изменено: {v.changes.map(k=>labels.get(k)??({definition:'формулировки и шаблоны',positions:'позиция заказчика',attachments:'приложения',notes:'внутренние пометки',nominations:'номинированные стоимости'}[k]??k)).join(', ')}</li>)}</ul>
   {packet.builds.slice(1).map(b=><details key={b.id}><summary>Черновик от {new Date(b.created_at).toLocaleString('ru-RU')}</summary><ul>{b.files.map(f=><li key={f.id}><a href={`/api/v1/form-packet-files/${f.id}`} target="_blank" rel="noreferrer">{f.name}</a></li>)}</ul></details>)}
  </details>
 </section>;
};
