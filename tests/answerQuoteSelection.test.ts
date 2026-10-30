// S18-32: модель выбирает цитаты, а не переписывает их. Только обезличенные примеры.
import {describe,expect,it} from 'vitest';
import * as core from '../packages/core/src/index.ts';
import {draftUserContent,parseDraft,planQuestion,type IPacketItem} from '../packages/core/src/index.ts';
const question='Сравни аванс в КП и ДГП: право и размер.';
const text='Заказчик вправе предоставить аванс не более 25% после получения банковской гарантии.';
const item:IPacketItem={label:'E1',fragmentId:'f1',text,origin:'document_text',sourceUnitId:'u1',documentKey:'d1',documentTitle:'ДГП.docx',versionNote:'current',reason:'test'};
const choice={id:'@E1Q1',evidenceId:'E1',text};
const raw=(id:string,evidence='E1')=>JSON.stringify({claims:[{text:id,kind:'amount',evidence_ids:[evidence]}]});
// Третий параметр — проверяемый новый контракт, на прежнем коде игнорируется.
const parse=()=>core.parseDraft as unknown as (s:string,m:Map<string,string>,q:Map<string,typeof choice>)=>ReturnType<typeof parseDraft>;
const choices=()=> (core as unknown as {draftQuoteChoices:(i:IPacketItem[],q:string)=>typeof choice[]}).draftQuoteChoices;
describe('S18-32: выбор готовых цитат',()=>{
 it('сложный вопрос получает идентификаторы и подсказки только своего пакета',()=>{
  const input=JSON.parse(draftUserContent({question,plan:planQuestion(question),history:[],items:[item],places:new Map()}));
  expect(input.quote_choices).toEqual(expect.arrayContaining([expect.objectContaining({id:'@E1Q1',evidence_id:'E1',starts_with:expect.any(String)})]));
 });
 it('выбор ID подставляет исходный текст и сохраняет его действительное основание',()=>{
  const result=parse()(raw('@E1Q1'),new Map(),new Map([[choice.id,choice]]));
  expect(result.claims[0]).toMatchObject({text,kind:'fact',evidenceIds:['E1']});
 });
 it.each([['@E9Q9','E1'],['@E1Q1','E2']])('неверная ссылка %s/%s отклоняется отдельно от верной цитаты',(bad,ref)=>{
  const input=JSON.stringify({claims:[{text:bad,evidence_ids:[ref]},{text:choice.id,evidence_ids:['E1']}]});
  const result=parse()(input,new Map(),new Map([[choice.id,choice]]));
  const context={evidenceById:new Map([['E1',item]]),allowedSourceUnitIds:new Set(['u1']),versionPolicy:'current' as const,question};
  expect(result.claims).toHaveLength(2);
  expect(result.claims.map(c=>core.checkClaim(c,context).passed)).toEqual([false,true]);
 });
 it('не превращает незавершённую выдержку в законченное предложение',()=>{
  const e={...item,text:'Заказчик вправе предоставить аванс после получения гарантии'};
  const claim={claimId:'c1',text:e.text,kind:'fact' as const,evidenceIds:['E1']};
  const check=core.checkClaim(claim,{evidenceById:new Map([['E1',e]]),allowedSourceUnitIds:null,versionPolicy:'current',question});
  const result=core.renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',check]]),items:[e],level:'hard_checks',question});
  expect(result.answer).toContain(`«${e.text}»`);
  expect(result.answer).not.toContain('гарантии.');
 });
 it('одинаковые цитаты двух редакций сохраняют отдельные основания',()=>{
  const second={...choice,id:'@E2Q1',evidenceId:'E2'};
  const input=JSON.stringify({claims:[{text:choice.id,evidence_ids:['E1']},{text:second.id,evidence_ids:['E2']}]});
  const result=parse()(input,new Map(),new Map([[choice.id,choice],[second.id,second]]));
  expect(result.claims.map(c=>c.evidenceIds)).toEqual([['E1'],['E2']]);
 });
 it('длинные основания дают ограниченные непрерывные выдержки без склейки разных источников',()=>{
  const original=Array.from({length:8},(_,i)=>`Заказчик вправе предоставить аванс ${i+10}% после получения банковской гарантии.`).join(' ');
  const result=choices()([{...item,text:original}],question);
  expect(result.length).toBeGreaterThan(1);
  for(const q of result){expect(q.text.length).toBeLessThanOrEqual(600);expect(original.includes(q.text)).toBe(true);expect(q.evidenceId).toBe('E1');}
  expect(choices()([item],'Какой аванс?')).toEqual([]);
 });
});
