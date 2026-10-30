// S18-32: обезличенные регрессии реального повтора. Ожидания — по смыслу источников, не по ответам модели.
import { describe, expect, it } from 'vitest';
import { buildPacket, checkClaim, planQuestion, renderVerifiedAnswer, type IPacketCandidate, type IPacketItem, type ClaimKind } from '../packages/core/src/index.ts';

const candidate = (id: string, text: string, title: string, rank: number, documentKey = id): IPacketCandidate & { documentTitle: string } => ({ fragmentId: id, text, origin: 'document_text', sourceUnitId: documentKey, documentKey, documentTitle: title, ownerKey: 'tender:one', rank, reason: `search:${rank}` });
const item = (label: string, text: string, title = 'Договор.docx'): IPacketItem & { documentTitle: string } => ({ ...candidate(label, text, title, 0), label, versionNote: 'current' });
const check = (text: string, evidence: IPacketItem[], kind: ClaimKind = 'fact') => checkClaim({ claimId: 'c1', kind, text, evidenceIds: evidence.map(e => e.label) }, { evidenceById: new Map(evidence.map(e => [e.label, e])), allowedSourceUnitIds:null, versionPolicy:'current' });
const codes = (result: ReturnType<typeof check>) => result.issues.map(i => i.code);
const packet = (question: string, candidates: IPacketCandidate[], limit = 12) => buildPacket(candidates, new Map(), limit, undefined, { question });

describe('S18-32: отбор оснований по предмету вопроса', () => {
  it('ставка удержания имеет приоритет перед возвратом доли уже удержанной суммы', () => {
    const release=candidate('release','50% от неизрасходованной суммы Гарантийного удержания по Отделочным работам.','ДГП.docx',0,'dgp');
    const rate=candidate('rate','Заказчик удерживает в качестве Гарантийного удержания 7 (Семь) % от стоимости Отделочных работ.','ДГП.docx',20,'dgp');
    expect(packet('Сравни гарантийное удержание в КП и ДГП: ставки и база удержания.',[release,rate],1).map(e=>e.fragmentId)).toEqual(['rate']);
  });

  it('ставки и определения МОП и квартир не вытесняются множеством копий КП', () => {
    const contract=[
      candidate('general-rate','Заказчик удерживает в качестве Гарантийного удержания 4 (Четыре) % от стоимости Строительных работ, за исключением Отделочных работ.','ДГП.docx',20,'dgp'),
      candidate('finish-rate','Заказчик удерживает в качестве Гарантийного удержания 7 (Семь) % от стоимости Отделочных работ.','ДГП.docx',21,'dgp'),
      candidate('mop','Отделочные работы по МОП - работы по дизайн-проекту общих помещений.','ДГП.docx',22,'dgp'),
      candidate('apartments','Отделочные работы по квартирам - работы по отделке квартир объекта.','ДГП.docx',23,'dgp'),
    ];
    const offers=Array.from({length:14},(_,i)=>candidate(`offer${i}`,'Гарантийное удержание — 4% СМР, 7% отделка МОП.','КП.docx',i,`offer${i}`));
    const result=packet('Сравни гарантийное удержание в КП и ДГП: ставки, определения отделочных работ, МОП и квартир.',[...offers,...contract],8);
    expect(result.map(e=>e.fragmentId)).toEqual(expect.arrayContaining(['general-rate','finish-rate','mop','apartments']));
    expect(result.some(e=>e.documentTitle==='КП.docx')).toBe(true);
  });

  it('факты о заказчике из ПД не вытесняют неформализованное условие аванса КП/ДГП', () => {
    const noise = Array.from({ length: 15 }, (_, i) => ({ ...candidate(`pd${i}`, `Заказчик: ООО «Город ${i}». Проектная документация.`, `ПД-${i}.pdf`, i - 20), factHit: true }));
    const offer = candidate('offer', 'Предусмотрена возможность авансирования в пределах 25% при предоставлении банковской гарантии.', 'КП 12.04.2027.docx', 21);
    const contract = candidate('contract', 'Заказчик вправе перечислить аванс не более 25% после получения банковской гарантии.', 'ДГП редакция 2.docx', 22);
    const result = packet('Сравни условия авансирования в КП и ДГП: право заказчика, предел и банковская гарантия.', [...noise, offer, contract]);
    expect(result.map(e => e.fragmentId)).toEqual(expect.arrayContaining(['offer', 'contract']));
    expect(result.some(e => e.fragmentId.startsWith('pd'))).toBe(false);
  });

  it('для решения торгов выбирается протокол комитета, а не акт с тем же числом', () => {
    const act = candidate('act', 'Акт приемки работ. Подрядчик: ООО «Вектор». ИТОГО к оплате: 45 000 рублей.', 'Акт № 1.pdf', 0);
    const protocol = candidate('protocol', 'Выписка из протокола тендерного комитета. Признать победителем ООО «Маяк» с ценой 45 000 рублей.', 'Выписка из протокола ТК.pdf', 20);
    expect(packet('Какой результат торгов зафиксирован в протоколе тендерного комитета?', [act, protocol], 1).map(e => e.fragmentId)).toEqual(['protocol']);
  });

  it('ссылка договора на комитет не превращает договор в протокол торгов',()=>{
    const clause=candidate('contract','При изменении стоимости работ вопрос передается на рассмотрение тендерного комитета.','ДГП редакция 2.docx',0);
    const protocol=candidate('protocol','Признать победителем ООО «Маяк».','Выписка из протокола ТК.pdf',20);
    expect(packet('Какой результат торгов зафиксирован в протоколе тендерного комитета?',[clause,protocol]).map(e=>e.fragmentId)).toEqual(['protocol']);
  });

  it('график и форма будущего субподрядного договора не подменяют условия КП/ДГП',()=>{
    const schedule=candidate('schedule','Аванс перечисляется в размере 25%.','График авансов к ДГП.xlsx',0);
    const template=candidate('template','Аванс перечисляется в размере 25%.','Пр. 19 Форма договора с подрядчиком.docx',1);
    const contract=candidate('contract','Заказчик вправе предоставить аванс в размере 25%.','ДГП редакция 2.docx',10);
    expect(packet('Сравни условия авансирования в КП и ДГП.',[schedule,template,contract]).map(e=>e.fragmentId)).toEqual(['contract']);
  });

  it('техническое «Итого» не является общей стоимостью коммерческого предложения',()=>{
    const report=candidate('report','Итого расходы: 80 рублей.','НТО аэродинамических исследований.pdf',0);
    const offer=candidate('offer','Стоимость предложения составляет 90 рублей.','КП 12.04.2027.pdf',1);
    expect(packet('Проследи историю стоимости КП 12.04.2027.',[report,offer]).map(e=>e.fragmentId)).toEqual(['offer']);
  });

  it('слово «итогового» в комментарии к сметной позиции не является строкой итогов',()=>{
    const line=candidate('line','Светильник | 15 рублей | Нет итогового количества в проектной документации.','Форма КП 12.04.2027.xlsx',0);
    expect(packet('Проследи историю общей стоимости КП 12.04.2027.',[line])).toEqual([]);
  });

  it('строка ВСЕГО поздней оферты получает место до шаблонов и непрошенных дат',()=>{
    const noise=Array.from({length:14},(_,i)=>candidate(`template${i}`,'ИТОГО: 90 рублей.',`Пр. ${i} Форма КП.xlsx`,i));
    const late=candidate('late','ВСЕГО (стоимость руб. с НДС 20%) | 100 | 50 | 150','Форма КП_2027-04-19.xlsx',100);
    expect(packet('Проследи историю общей стоимости КП 12.04.2027 и 19.04.2027.',[...noise,late],1).map(e=>e.fragmentId)).toEqual(['late']);
  });

  it('названия денежных колонок с одним процентом НДС не являются итоговой суммой',()=>{
    const header=candidate('header','Стоимость ВСЕГО (руб. с НДС 20%)','Форма КП 12.04.2027.xlsx',0);
    expect(packet('Проследи историю общей стоимости КП 12.04.2027.',[header])).toEqual([]);
  });

  it('рублёвый лимит аванса выбирается раньше короткой фразы о возврате',()=>{
    const short=candidate('short','Перечислить заказчику сумму непогашенных авансов.','ДГП.docx',-20,'dgp');
    const cap=candidate('cap','Заказчик вправе выплатить аванс не более 80 000 000 рублей. После зачета лимит возобновляется.','ДГП.docx',30,'dgp');
    expect(packet('Сравни аванс в КП и ДГП: предел и возобновляемость.',[short,cap],1).map(e=>e.fragmentId)).toEqual(['cap']);
  });

  it('договор проектирования не подменяет явно запрошенный договор генерального подряда',()=>{
    const design=candidate('design','Предоставляется аванс в размере 50%.','Договор проектирования № 17.pdf',0);
    const general=candidate('general','Предоставляется аванс в размере 20%.','ДГП.docx',1);
    expect(packet('Сравни аванс в КП и договоре генерального подряда.',[design,general]).map(e=>e.fragmentId)).toEqual(['general']);
  });

  it('сравнение редакций оставляет место обеим частям разделённой оферты и другим датам', () => {
    const repeated = Array.from({ length: 12 }, (_, i) => candidate(`first${i}`, `Стоимость предложения — ${100 + i} рублей. Пункт ${i}.`, 'КП 12.04.2027.pdf', i, 'first'));
    const a = candidate('partA', 'Стоимость предложения, часть А: 60 рублей.', 'КП 19.04.2027 часть А.pdf', 30);
    const b = candidate('partB', 'Стоимость предложения, часть Б: 70 рублей.', 'КП 19.04.2027 часть Б.pdf', 31);
    expect(packet('Проследи изменение стоимости КП по подачам 12.04.2027 и 19.04.2027, учитывай обе части оферты.', [...repeated, a, b], 4).map(e => e.fragmentId)).toEqual(expect.arrayContaining(['partA','partB']));
  });

  it('история стоимости и сравнение редакций не планируются как только текущая редакция', () => {
    expect(planQuestion('Проследи изменение общей стоимости КП по подачам 12.04.2027, 19.04 и 03–04.05.').versionPolicy).toBe('all');
    expect(planQuestion('Сравни изменение аванса между редакциями договора.').versionPolicy).toBe('all');
  });

  it('короткие даты и диапазон в вопросе привязаны к явно указанному году', () => {
    expect(planQuestion('Проследи стоимость КП с 12.04.2027, затем 19.04, 03–04.05 и 15.05.').dates).toEqual(['12.04.2027','19.04.2027','03.05.2027','04.05.2027','15.05.2027']);
  });
});

describe('S18-32: число и существующая ссылка не доказывают смысл утверждения', () => {
  const act = item('E1', 'Акт приемки работ от 01.07.2027. Подрядчик: ООО «Вектор». ИТОГО к оплате: 45 000 рублей.', 'Акт № 1 от 01.07.2027.pdf');
  it.each([
    ['Победитель торгов — ООО «Вектор»', 'fact'],
    ['Итоговая стоимость торгов составляет 45 000 рублей', 'amount'],
    ['Дата протокола тендерного комитета — 01.07.2027', 'date'],
  ] as const)('отклоняет акт, выданный за решение торгов: %s', (text, kind) => {
    expect(check(text,[act],kind).passed).toBe(false);
  });

  it('процент индексации материалов не подтверждает процент удержания', () => {
    const e = item('E1','В стоимости работ учтён рост стоимости материалов 5%.','КП.docx');
    expect(check('Гарантийное удержание составляет 5%',[e],'percentage').passed).toBe(false);
  });

  it('право на аванс не превращается в обязанность при совпадающей сумме', () => {
    const e = item('E1','Заказчик вправе предоставить аванс в размере 25% при получении банковской гарантии.');
    expect(check('Заказчик обязан предоставить аванс в размере 25%',[e],'percentage').passed).toBe(false);
    expect(check('Заказчик вправе предоставить аванс в размере 25%',[e],'percentage').passed).toBe(true);
  });

  it('отрицание выплаты не подтверждает положительное обязательство с тем же процентом', () => {
    const e = item('E1','Аванс в размере 25% не выплачивается.');
    expect(check('Аванс в размере 25% выплачивается',[e],'percentage').passed).toBe(false);
  });

  it('названный в протоколе участник не подменяет указанного победителя', () => {
    const e = item('E1','Участник: ООО «Вектор». Признать победителем ООО «Маяк».','Протокол тендерного комитета.docx');
    expect(check('Победитель торгов — ООО «Вектор»',[e]).passed).toBe(false);
    expect(check('Победитель торгов — ООО «Маяк»',[e]).passed).toBe(true);
  });

  it('утверждение об одинаковых КП и ДГП не подтверждается ссылками только на КП', () => {
    const e = item('E1','Расходы на содержание площадки компенсируются заказчиком.','Коммерческое предложение.docx');
    expect(check('В КП и ДГП условия компенсации расходов на содержание площадки одинаковы',[e]).passed).toBe(false);
  });

  it('определение удержания не доказывает отсутствия ставки во всём документе', () => {
    const e = item('E1','Гарантийное удержание — обеспечительный платеж, вносимый путём удержания при оплате работ.');
    expect(check('Ставка гарантийного удержания в договоре не указана',[e]).passed).toBe(false);
  });

  it('явное отсутствие условия в самом источнике можно процитировать', () => {
    const e = item('E1','Гарантийное удержание не предусмотрено.');
    expect(check('Гарантийное удержание не предусмотрено',[e]).passed).toBe(true);
  });

  it('изменение размера при двух источниках не скрывает смену права на обязанность', () => {
    const first = item('E1','Заказчик вправе предоставить аванс в размере 20%.','ДГП редакция 1.docx');
    const second = item('E2','Заказчик обязан предоставить аванс в размере 25%.','ДГП редакция 2.docx');
    expect(check('Заказчик обязан предоставить аванс в размере 20%',[first,second],'percentage').passed).toBe(false);
  });

  it('одна точная цитата не позволяет приписать то же условие другой редакции',()=>{
    const first=item('E1','Аванс составляет 20%.','ДГП редакция 1.docx');
    const second=item('E2','Аванс составляет 25%.','ДГП редакция 2.docx');
    const claim={claimId:'c1',text:first.text,kind:'percentage' as const,evidenceIds:['E1','E2']};
    expect(checkClaim(claim,{evidenceById:new Map([['E1',first],['E2',second]]),allowedSourceUnitIds:null,versionPolicy:'all',question:'Сравни аванс между редакциями договора.'}).passed).toBe(false);
  });
});

describe('S18-32: частичный ответ сохраняет полезные факты и показывает неполноту', () => {
  it('одна дата не выдаётся за полную историю запрошенных подач', () => {
    const e = item('E1','Стоимость предложения составляет 90 000 рублей.','КП 12.04.2027.docx');
    const claim = {claimId:'c1',text:e.text,kind:'amount' as const,evidenceIds:['E1']};
    const result = renderVerifiedAnswer({ claims:[claim],checks:new Map([['c1',checkClaim(claim,{evidenceById:new Map([['E1',e]]),allowedSourceUnitIds:null,versionPolicy:'all'})]]),items:[e],level:'hard_checks',plan:planQuestion('Проследи историю стоимости КП по подачам 12.04.2027 и 19.04.2027.') });
    expect(result.outcome).toBe('insufficient');
    expect(result.claims[0]?.shown).toBe(true);
    expect(result.answer).toContain('19.04.2027');
    expect(result.answer).toContain('90 000');
  });

  it('незакрытые вопросы модели не исчезают из итогового статуса', () => {
    const e=item('E1','Гарантийное удержание составляет 3%.');
    const claim={claimId:'c1',text:e.text,kind:'percentage' as const,evidenceIds:['E1']};
    const result=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',checkClaim(claim,{evidenceById:new Map([['E1',e]]),allowedSourceUnitIds:null,versionPolicy:'current'})]]),items:[e],level:'hard_checks',openQuestions:1});
    expect(result.outcome).toBe('insufficient');
    expect(result.answer).toMatch(/частич|неполн/iu);
  });

  it('две части оферты одной даты не считаются покрытыми по цитате только одной части',()=>{
    const first=item('E1','Стоимость предложения, часть А: 60 рублей.','КП 12.04.2027 часть А.pdf');
    const second=item('E2','Стоимость предложения, часть Б: 70 рублей.','КП 12.04.2027 часть Б.pdf');
    const claim={claimId:'c1',text:first.text,kind:'amount' as const,evidenceIds:['E1']};
    const result=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',checkClaim(claim,{evidenceById:new Map([['E1',first],['E2',second]]),allowedSourceUnitIds:null,versionPolicy:'all'})]]),items:[first,second],level:'hard_checks',plan:planQuestion('Проследи изменение стоимости КП 12.04.2027, учитывай обе части оферты.'),question:'Проследи изменение стоимости КП 12.04.2027, учитывай обе части оферты.'});
    expect(result.outcome).toBe('insufficient');
    expect(result.answer).toContain('часть Б');
    // Название непокрытого источника в тексте — тоже зависимость видимости ответа.
    expect(result.sources.map(e=>e.label)).toContain('E2');
  });

  it('одинаковые имена файлов не склеивают разные редакции и части',()=>{
    const first=item('E1','Стоимость предложения составляет 60 рублей.','КП 12.04.2027.pdf');
    const second=item('E2','Стоимость предложения составляет 70 рублей.','КП 12.04.2027.pdf');
    const claim={claimId:'c1',text:first.text,kind:'amount' as const,evidenceIds:['E1']};
    const result=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',checkClaim(claim,{evidenceById:new Map([['E1',first]]),allowedSourceUnitIds:null,versionPolicy:'all'})]]),items:[first,second],level:'hard_checks',plan:planQuestion('Проследи историю стоимости КП 12.04.2027.'),question:'Проследи историю стоимости КП 12.04.2027.'});
    expect(result.outcome).toBe('insufficient');
  });

  it('разные цены в последовательных подачах — история, а не конфликт',()=>{
    const first=item('E1','Предложение направлено 12.04.2027. Стоимость предложения составляет 60 рублей.','КП 12.04.2027.pdf');
    const second=item('E2','Предложение направлено 19.04.2027. Стоимость предложения составляет 70 рублей.','КП 19.04.2027.pdf');
    const evidenceById=new Map([['E1',first],['E2',second]]);
    const claims=[first,second].map((e,i)=>({claimId:`c${i}`,text:e.text.slice(e.text.indexOf('Стоимость')),kind:'amount' as const,evidenceIds:[e.label]}));
    const checks=new Map(claims.map(c=>[c.claimId,checkClaim(c,{evidenceById,allowedSourceUnitIds:null,versionPolicy:'all'})]));
    // Контроль сохраняет смысл сценария: те же одиночные суммы в текущем значении конфликтуют.
    const current=renderVerifiedAnswer({claims,checks,items:[first,second],level:'hard_checks',plan:planQuestion('Какова стоимость?'),question:'Какова стоимость?'});
    expect(current.outcome).toBe('conflict');
    expect(current.conflictCitations).toHaveLength(2);
    const question='Проследи историю стоимости КП 12.04.2027 и 19.04.2027.';
    const result=renderVerifiedAnswer({claims,checks,items:[first,second],level:'hard_checks',plan:planQuestion(question),question});
    expect(result.outcome).toBe('confirmed');
    expect(result.missingDates).toEqual([]);
    expect(result.answer).not.toMatch(/расхождение/iu);
  });

  it('счётчик непокрытых источников различает одноимённые редакции',()=>{
    const items=[item('E1','Стоимость предложения составляет 60 рублей.','КП 12.04.2027.pdf'),item('E2','Стоимость предложения составляет 70 рублей.','КП 12.04.2027.pdf'),item('E3','Стоимость предложения составляет 80 рублей.','КП 12.04.2027.pdf')];
    const claim={claimId:'c1',text:items[0]!.text,kind:'amount' as const,evidenceIds:['E1']};
    const question='Проследи историю стоимости КП 12.04.2027.';
    const result=renderVerifiedAnswer({claims:[claim],checks:new Map([['c1',checkClaim(claim,{evidenceById:new Map([['E1',items[0]!]]),allowedSourceUnitIds:null,versionPolicy:'all'})]]),items,level:'hard_checks',plan:planQuestion(question),question});
    expect(result.missingDocuments).toBe(2);
  });
});
