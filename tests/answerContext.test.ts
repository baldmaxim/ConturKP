import {describe,it,expect} from 'vitest';
import {buildPacket,checkClaim,draftQuoteChoices,parseDraft,planQuestion,renderVerifiedAnswer,type IPacketCandidate,type IPacketItem} from '../packages/core/src/index.ts';
const price='Проследи историю стоимости КП 12.04.2027 и 19.04.2027, учитывай обе части.';
const award='Какой результат торгов и условия генподрядного вознаграждения в протоколе тендерного комитета?';
const c=(id:string,text:string,part:string,rank=0)=>({fragmentId:id,text,origin:'document_text',sourceUnitId:'u1',documentKey:'d1',documentTitle:'Приложение РСР_2027-04-19.xlsx',sourcePart:part,ownerKey:'tender:t',rank,reason:'test'});
const items=(rows:IPacketCandidate[])=>buildPacket(rows,new Map(),12,undefined,{question:price});
const p=(id:string,text:string,ordinal:number,page=0,unit='proto')=>({fragmentId:id,label:id,text,origin:'recognized_text',sourceUnitId:unit,documentKey:'protocol',documentTitle:'Выписка из протокола ТК.pdf',sourceOrder:{page,ordinal,part:0},versionNote:'current' as const,reason:'test'});
const protocol=()=>[p('E1','ВИС является открытой ценой с вознаграждением 7% с принятием',1),p('E2','ответственности за работы субподрядчика через тендерные',2),p('E3','процедуры.',3)];
describe('S18-32: контекст частей и продолжений',()=>{
 it('РСР обеих частей получает место до копий КП и непрошенных дат',()=>{
  const noise=Array.from({length:14},(_,i)=>({...c(`n${i}`,'Стоимость предложения составляет 90 рублей.','',i),sourceUnitId:`n${i}`,documentKey:`n${i}`,documentTitle:'КП 12.04.2027.pdf'}));
  const a=c('a','ВСЕГО: 60 рублей.','РСР_Часть1',30),b=c('b','ИТОГО: 70 рублей.','РСР_Часть2',31);
  const result=buildPacket([...noise,a,b],new Map(),4,undefined,{question:price});
  expect(result.map(e=>e.fragmentId)).toEqual(expect.arrayContaining(['a','b']));
 });
 it('несколько подытогов первого листа не вытесняют второй лист',()=>{
  const a=c('a','ВСЕГО: 100 рублей.','Часть1');
  const subtotal=Array.from({length:4},(_,i)=>c(`s${i}`,`ИТОГО: ${i+10} рублей.`,'Часть1',i+1));
  const b=c('b','ИТОГО: 70 рублей.','Часть2',30);
  expect(buildPacket([a,...subtotal,b],new Map(),2,undefined,{question:price}).map(e=>e.fragmentId)).toEqual(expect.arrayContaining(['a','b']));
 });
 it('частично показанный разделённый блок не соединяется со следующим блоком',()=>{
  const rows=[{...protocol()[0]!,sourceOrder:{page:0,ordinal:1,part:0,total:2}},protocol()[1]!];const qs=draftQuoteChoices(rows,award);const q=qs.find(q=>q.evidenceId==='E1')!;
  expect(parseDraft(JSON.stringify({claims:[{text:q.id,evidence_ids:['E1']}]}),new Map(),new Map(qs.map(q=>[q.id,q]))).claims).toHaveLength(1);
 });
 it('одинаковые суммы разных листов одного распознавания не склеиваются и не считаются покрытыми одной цитатой',()=>{
  const result=items([c('a','ВСЕГО: 60 рублей.','Часть1'),c('b','ВСЕГО: 60 рублей.','Часть2')]);expect(result).toHaveLength(2);
  const claim={claimId:'c1',text:result[0]!.text,kind:'fact' as const,evidenceIds:[result[0]!.label]};
  const ctx={evidenceById:new Map(result.map(e=>[e.label,e])),allowedSourceUnitIds:null,versionPolicy:'all' as const,question:price};
  const r=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',checkClaim(claim,ctx)]]),items:result,level:'hard_checks',question:price,plan:planQuestion(price)});
  expect(r.missingDocuments).toBe(1);expect(r.answer).toContain('Часть2');
 });
 it('выбор начала условия сохраняет соседние продолжения отдельными проверяемыми цитатами',()=>{
  const rows=protocol();const qs=draftQuoteChoices(rows,award);const q=qs.find(q=>q.evidenceId==='E1')!;
  const r=parseDraft(JSON.stringify({claims:[{text:q.id,evidence_ids:['E1']}]}),new Map(),new Map(qs.map(q=>[q.id,q])));
  expect(r.claims.map(c=>c.text)).toEqual(rows.map(e=>e.text));expect(r.claims.map(c=>c.evidenceIds)).toEqual([['E1'],['E2'],['E3']]);
 });
 it('совпадающий номер блока на другой странице или в другом источнике не является продолжением',()=>{
  for(const next of [p('E2','ответственности за работы субподрядчика.',2,1),p('E2','ответственности за работы субподрядчика.',2,0,'other')]){
   const rows=[protocol()[0]!,next];const qs=draftQuoteChoices(rows,award);const q=qs.find(q=>q.evidenceId==='E1')!;
   const r=parseDraft(JSON.stringify({claims:[{text:q.id,evidence_ids:['E1']}]}),new Map(),new Map(qs.map(q=>[q.id,q])));expect(r.claims).toHaveLength(1);
  }
 });
 it('короткое продолжение допускается только с проверенным соседним условием в пакете',()=>{
  const rows=protocol();const claim={claimId:'c1',text:rows[2]!.text,kind:'fact' as const,evidenceIds:['E3']};
  const check=(e:IPacketItem[])=>checkClaim(claim,{evidenceById:new Map(e.map(i=>[i.label,i])),allowedSourceUnitIds:null,versionPolicy:'current',question:award});
  expect(check(rows).passed).toBe(true);expect(check([rows[2]!]).passed).toBe(false);expect(check(rows.slice(1)).passed).toBe(false);
 });
 it('расширение контекста не превышает лимит утверждений и помечает обрезку',()=>{
  const qs=Array.from({length:24},(_,i)=>({id:`@E${Math.floor(i/3)+1}Q${i%3+1}`,evidenceId:`E${Math.floor(i/3)+1}`,text:`Условие ${i}`,contextIds:[] as string[]}));
  for(const q of qs)q.contextIds=qs.slice(qs.indexOf(q)<12?0:12,qs.indexOf(q)<12?12:24).map(q=>q.id);
  const input=JSON.stringify({claims:[{text:qs[0]!.id,evidence_ids:['E1']},{text:qs[12]!.id,evidence_ids:['E5']},{text:'@E99Q99',evidence_ids:['E99']}]});
  const r=parseDraft(input,new Map(),new Map(qs.map(q=>[q.id,q])));expect(r.claims).toHaveLength(20);expect(r.openQuestions).toBeGreaterThan(0);
 });
 it('строки стоимости сами по себе не становятся причиной изменения',()=>{
  const e={...p('E1','Стоимость предложения составляет 90 рублей.',1),documentTitle:'КП 12.04.2027.pdf'};
  const claim={claimId:'c1',text:e.text,kind:'fact' as const,evidenceIds:['E1']};const check=checkClaim(claim,{evidenceById:new Map([['E1',e]]),allowedSourceUnitIds:null,versionPolicy:'all',question:price});
  const r=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',check]]),items:[e],level:'hard_checks',question:price,plan:planQuestion(price)});expect(r.answer).toContain('Причина изменения по этим выдержкам не установлена');
 });
});
