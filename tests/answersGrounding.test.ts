// S18-32 через БД/API/worker, без живой модели и без коммерческих данных.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerTopicCandidates } from '../packages/db/src/index.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { ask, buildAnswerStage, draftJson, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { seedEvidenceRun, uploadDocument } from './searchFixtures.ts';

const config=testConfig();
let db:ITestDb, st:IAnswerStage;
const ADV='Заказчик вправе предоставить аванс не более 25% при получении банковской гарантии.';
const OFFER='Возможно авансирование в пределах 25% под банковскую гарантию.';
const PRICE='Стоимость предложения составляет 90 000 рублей.';
const TOTAL='ВСЕГО (стоимость руб. с НДС 20%) | 100 | 50 | 150';
const FEE='ВИС является открытой ценой с вознаграждением 7% с принятием';
const CONT='ответственности за работы субподрядчика через тендерные';
const TAIL='процедуры.';
const DECISION='Признать победителем ООО «Маяк» с итоговой ценой 45 000 рублей.';
const ACT='Акт приемки работ. Подрядчик: ООО «Вектор». ИТОГО к оплате: 45 000 рублей.';
const RETENTION_RATE='Заказчик удерживает в качестве Гарантийного удержания 7 (Семь) % от стоимости Отделочных работ, принятых в Отчетном периоде.';
const FINISHING='Отделочные работы по квартирам - работы по отделке квартир объекта.';
beforeAll(async()=>{
  db=await createTestDb();
  const docs=Object.fromEntries(Array.from({length:15},(_,i)=>[`ПД-${i}.pdf`,{pages:[{blocks:[`Заказчик: ООО «Город ${i}». Проектная документация.`]}]}]));
  st=await buildAnswerStage(db,config,{
    ...docs,
    'ДГП редакция 2.pdf':{pages:[{blocks:[...Array.from({length:30},(_,i)=>`Аванс, заголовок ${i}.`),ADV]}]},
    'ДГП удержания.pdf':{pages:[{blocks:[...Array.from({length:35},(_,i)=>`${i+10}% от неизрасходованной суммы Гарантийного удержания по Отделочным работам.`),RETENTION_RATE,FINISHING]}]},
    'КП 12.04.2027.pdf':{pages:[{blocks:[OFFER,PRICE]}]},
    'РСР_2027-04-19.pdf':{pages:[{sheetLabel:'РСР_Часть1',blocks:['ВСЕГО: 60 рублей.']},{sheetLabel:'РСР_Часть2',blocks:['ИТОГО: 70 рублей.']}]},
    'Форма КП_2027-04-19.pdf':{pages:[{blocks:[TOTAL]}]},
    'Протокол тендерного комитета.pdf':{pages:[{blocks:['Выписка из протокола тендерного комитета от 15.04.2027.',DECISION,FEE,CONT,TAIL]}]},
    'Акт №1.pdf':{pages:[{blocks:[ACT]}]},
  });
});
afterAll(async()=>db?.drop());
const extract=(user:string,text:string)=>{
  const e=JSON.parse(user).evidence.find((e:{text:string})=>e.text.includes(text));
  return e ? draftJson([{text,kind:'percentage',evidence:[e.label]}]) : draftJson([]);
};
describe('S18-32 — сквозные регрессии',()=>{
  it('SQL сохраняет лист и порядок фрагментов расчётного приложения',async()=>{
    const rows=await answerTopicCandidates(db.pool,'Проследи историю стоимости КП 12.04.2027 и 19.04.2027.',Object.values(st.runs));
    const parts=rows.filter(r=>r.documentTitle==='РСР_2027-04-19.pdf') as (typeof rows[number]&{sourcePart?:string;sourceOrder?:{page:number;ordinal:number;part:number}})[];
    expect(parts.map(p=>p.sourcePart)).toEqual(expect.arrayContaining(['РСР_Часть1','РСР_Часть2']));expect(parts.every(p=>p.sourceOrder && Number.isInteger(p.sourceOrder.ordinal))).toBe(true);
  });
  it('выбранное начало условия протокола сохраняет оба продолжения через worker',async()=>{
    st.chat.scenario=i=>{
      if(i.task!=='answer_draft')return null;
      const input=JSON.parse(i.user);const e=input.evidence.find((e:{label:string;text:string})=>e.text===FEE);const q=input.quote_choices?.find((q:{evidence_id:string})=>q.evidence_id===e?.label);
      return q?draftJson([{text:q.id,kind:'fact',evidence:[q.evidence_id]}]):draftJson([]);
    };
    const d=await newDialog(st.s.eng1,workingContext(st));const r=await ask(st,st.s.eng1,d,'Какой результат торгов и условия генподрядного вознаграждения в протоколе тендерного комитета?');
    expect(r.answer!.claims.map(c=>c.text)).toEqual(expect.arrayContaining([FEE,CONT,TAIL]));
  });

  it('ID выбранной моделью цитаты проходит через API как дословное условие источника',async()=>{
    st.chat.scenario=i=>{
      if(i.task!=='answer_draft')return null;
      const input=JSON.parse(i.user);
      const e=input.evidence.find((e:{label:string;text:string})=>e.text===ADV);
      const q=input.quote_choices?.find((q:{id:string;evidence_id:string})=>q.evidence_id===e?.label);
      return q?draftJson([{text:'@E999Q999',kind:'fact',evidence:[q.evidence_id]},{text:q.id,kind:'fact',evidence:[q.evidence_id]}]):draftJson([]);
    };
    const d=await newDialog(st.s.eng1,workingContext(st));
    const r=await ask(st,st.s.eng1,d,'Сравни аванс в КП и ДГП: право и банковская гарантия.');
    expect(r.answer!.claims.map(c=>c.text)).toContain(ADV);
    expect(r.answer!.text).not.toMatch(/@E\d+Q\d+/u);
    expect(r.answer!.droppedClaims).toBe(1);
  });

  it('лимит SQL-кандидатов сохраняет ставку с числом прописью и определение работ перед условиями возврата',async()=>{
    const rows=await answerTopicCandidates(db.pool,'Сравни гарантийное удержание в КП и ДГП: ставки и определения отделочных работ.',Object.values(st.runs));
    expect(rows.some(r=>r.text===RETENTION_RATE)).toBe(true);
    expect(rows.some(r=>r.text===FINISHING)).toBe(true);
  });

  it('получает обе стороны аванса, несмотря на множество фактов о заказчике',async()=>{
    st.chat.scenario=i=>i.task==='answer_draft' ? extract(i.user,ADV) : null;
    const d=await newDialog(st.s.eng1,workingContext(st));
    const r=await ask(st,st.s.eng1,d,'Сравни условия авансирования в КП и ДГП: право заказчика и банковская гарантия.');
    const latest=[...st.chat.inputs].reverse().find(i=>i.task==='answer_draft')!;
    const texts=JSON.parse(latest.user).evidence.map((e:{text:string})=>e.text);
    expect(texts).toEqual(expect.arrayContaining([ADV,OFFER]));
    expect(texts.some((t:string)=>t.includes('Проектная документация'))).toBe(false);
    expect(r.answer!.claims.map(c=>c.text)).toContain(ADV.replace(/\.$/u,''));
    // Одно верное условие не считается завершённым сравнением двух сторон.
    expect(r.answerStatus).toBe('incomplete_processing');
  });

  it('дополнительный поиск не читает фрагменты другого тендера',async()=>{
    const rev=await uploadDocument(db,config,st.s.eng3,st.s.stageB,'Чужой аванс.pdf');
    const run=await seedEvidenceRun(db.pool,rev,{pages:[{blocks:['Секретный аванс составляет 99%.']} ]});
    const allowed=Object.values(st.runs);
    const rows=await answerTopicCandidates(db.pool,'Какой аванс?',allowed);
    expect(rows.some(r=>r.sourceUnitId===run || r.text.includes('Секретный'))).toBe(false);
    expect(rows.some(r=>r.text.includes(ADV))).toBe(true);
  });

  it('короткие заголовки не вытесняют содержательный пункт из лимита поиска',async()=>{
    const rows=await answerTopicCandidates(db.pool,'Сравни аванс в КП и ДГП.',Object.values(st.runs));
    expect(rows.some(r=>r.text===ADV)).toBe(true);
  });

  it('источник итогов торгов — решение комитета, а не акт; подпись акта не становится победой',async()=>{
    st.chat.scenario=i=>{
      if(i.task!=='answer_draft') return null;
      const evidence=JSON.parse(i.user).evidence as {label:string;text:string}[];
      const decision=evidence.find(e=>e.text.includes(DECISION));
      expect(evidence.some(e=>e.text.includes(ACT))).toBe(false);
      expect(decision).toBeTruthy();
      return draftJson([{text:DECISION,kind:'amount',evidence:[decision!.label]}]);
    };
    const d=await newDialog(st.s.eng1,workingContext(st));
    const r=await ask(st,st.s.eng1,d,'Какой результат торгов зафиксирован в протоколе тендерного комитета?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('Маяк');
    expect(r.answer!.text).not.toContain('Вектор');
  });

  it('одна подтверждённая подача сохраняется, а пропущенная дата названа явно',async()=>{
    st.chat.scenario=i=>{
      if(i.task!=='answer_draft') return null;
      const e=JSON.parse(i.user).evidence.find((e:{text:string})=>e.text===PRICE);
      return e ? draftJson([{text:PRICE,kind:'amount',evidence:[e.label]}]) : draftJson([]);
    };
    const d=await newDialog(st.s.eng1,workingContext(st));
    const r=await ask(st,st.s.eng1,d,'Проследи изменение стоимости КП по подачам 12.04.2027 и 19.04.2027.');
    expect(r.answerStatus).toBe('incomplete_processing');
    expect(r.answer!.text).toContain('90 000');
    expect(r.answer!.text).toContain('19.04.2027');
    expect(r.answer!.text).toMatch(/частич/iu);
    expect(typeof r.coverage.missingDocuments).toBe('number');
  });

  it('поздняя строка ВСЕГО доступна модели как дословная строка итогов, без выдуманного пересчёта колонок',async()=>{
    st.chat.scenario=i=>{
      if(i.task!=='answer_draft')return null;
      const e=JSON.parse(i.user).evidence.find((e:{text:string})=>e.text===TOTAL);
      return e?draftJson([{text:TOTAL,kind:'fact',evidence:[e.label]}]):draftJson([]);
    };
    const d=await newDialog(st.s.eng1,workingContext(st));
    const r=await ask(st,st.s.eng1,d,'Проследи историю общей стоимости КП 12.04.2027 и 19.04.2027.');
    expect(r.answer!.claims.map(c=>c.text)).toContain(TOTAL);
    expect(r.answer!.text).toContain('Форма КП_2027-04-19.pdf');
  });
});
