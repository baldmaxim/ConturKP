import { Decimal } from 'decimal.js';
export interface INomination { key:string; title:string; amount:string; vatIncluded:boolean|null; vatRate:string; gpPercent:string }
export interface IPerformanceBond {coveragePercent:string;annualRatePercent:string;months:string;addVat:boolean}
const D=Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP});
const n=(value:string,label:string):Decimal=>{if(!/^\d+(?:[.,]\d+)?$/u.test(value))throw new Error(`${label}: требуется неотрицательное число`);return new D(value.replace(',','.'));};
const plural=(v:bigint,forms:readonly[string,string,string]):string=>{
 const last=Number(v%100n);return forms[last>=11&&last<=19?2:Number(v%10n)===1?0:Number(v%10n)>=2&&Number(v%10n)<=4?1:2];
};
const small=(v:number,female=false):string=>{
 const hundreds=['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
 const ones=['','один','два','три','четыре','пять','шесть','семь','восемь','девять','десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
 const tens=['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
 const rest=v%100; const unit=(a:number)=>female&&a===1?'одна':female&&a===2?'две':ones[a]!;
 return [hundreds[Math.floor(v/100)],rest<20?unit(rest):`${tens[Math.floor(rest/10)]} ${unit(rest%10)}`].join(' ').trim().replace(/\s+/gu,' ');
};
export const moneyWords=(value:string):string=>{
 const d=n(value,'Сумма').toDecimalPlaces(2);if(d.gte('1000000000000000'))throw new Error('Сумма для прописи слишком велика');
 const cents=BigInt(d.times(100).toFixed(0)),rub=cents/100n,kop=cents%100n;
 let rest=rub;const parts:string[]=[];
 const ranks: {value:bigint;forms:readonly[string,string,string];female?:boolean}[]=[
  {value:1000000000000n,forms:['триллион','триллиона','триллионов']},{value:1000000000n,forms:['миллиард','миллиарда','миллиардов']},
  {value:1000000n,forms:['миллион','миллиона','миллионов']},{value:1000n,forms:['тысяча','тысячи','тысяч'],female:true},
 ];
 for(const rank of ranks){const count=rest/rank.value;if(count)parts.push(`${small(Number(count),rank.female)} ${plural(count,rank.forms)}`);rest%=rank.value;}
 if(rest)parts.push(small(Number(rest)));if(!rub)parts.push('ноль');
 const text=`${parts.join(' ')} ${plural(rub,['рубль','рубля','рублей'])} ${small(Number(kop),true)||'ноль'} ${plural(kop,['копейка','копейки','копеек'])}`;
 return text[0]!.toUpperCase()+text.slice(1);
};
export const formatPacketMoney=(value:string):string=>{
 const [whole,cents]=n(value,'Сумма').toFixed(2).split('.');return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/gu,' ')}${cents==='00'?',00':','+cents}`;
};
export const checkCalculationTotals=(header:string,positions:string)=>{
 const difference=new D(header).minus(new D(positions));
 if(!difference.isFinite())throw new Error('Итоги расчёта не определены');
 return {header,positions,difference:difference.toFixed(2),reconciled:difference.abs().lte('0.01'),differenceDisplay:(difference.isNegative()?'-':'')+formatPacketMoney(difference.abs().toFixed(2))};
};
export const packetMoney=(sourceTotal:string,rate:string,nominations:readonly INomination[],bond:IPerformanceBond|null=null):{fields:Record<string,string>;issues:string[];addition:string|null;total:string|null}=>{
 const base=n(sourceTotal,'Итог TenderHub'),baseRate=n(rate,'Ставка НДС');
 let addition=new D(0),vat=base.times(baseRate).div(baseRate.plus(100)).toDecimalPlaces(2);
 const fields:Record<string,string>={th_total:formatPacketMoney(base.toFixed(2)),performance_bond_clause:'Банковская гарантия обеспечения исполнения Работ (Performance bond) не предоставляется.',performance_bond_price_addition:'0,00'};
 fields.nominations_list=nominations.map(row=>`${row.title}: ${formatPacketMoney(row.amount)} руб. (${row.vatIncluded===null?'база НДС не определена':row.vatIncluded?'включая НДС':'без НДС'}). Генподрядный процент — ${row.gpPercent.replace('.',',')}%.`).join('\n');
 const issues:string[]=[];
 for(const row of nominations){
  const amount=n(row.amount,`${row.title}: сумма`),r=n(row.vatRate,`${row.title}: НДС`),gp=n(row.gpPercent,`${row.title}: ГП`);
  fields[`${row.key}_amount`]=formatPacketMoney(amount.toFixed(2));fields[`${row.key}_gp`]=gp.toFixed().replace('.',',');
  if(row.vatIncluded===null){issues.push(`Не определена база НДС: ${row.title}`);continue;}
  const gross=(row.vatIncluded?amount:amount.times(r.plus(100)).div(100)).toDecimalPlaces(2);
  const fee=gross.times(gp).div(100).toDecimalPlaces(2);
  const line=gross.plus(fee);
  addition=addition.plus(line);vat=vat.plus(line.times(r).div(r.plus(100)).toDecimalPlaces(2));
  fields[`${row.key}_total`]=formatPacketMoney(line.toFixed(2));
  if(!r.eq(baseRate))issues.push(`Ставка НДС раздела «${row.title}» отличается от основной; проверьте текст письма`);
 }
 if(issues.some(x=>x.startsWith('Не определена база НДС'))){
  return {fields:{...fields,kp_total:'[не согласована база НДС номинаций]',total_words:'[сумма не определена]',vat_amount:'[не определено]',vat_words:'[не определено]'},issues,addition:null,total:null};
 }
 const beforeBond=base.plus(addition);let gross=beforeBond;
 if(bond){
  const coverage=n(bond.coveragePercent,'Размер БГ'),annual=n(bond.annualRatePercent,'Тариф банка'),months=n(bond.months,'Срок БГ');
  if(coverage.gt(100)||!months.gt(0))throw new Error('Размер БГ не более 100%, срок должен быть положительным');
  const coefficient=coverage.div(100).times(annual.div(100)).times(months.div(12));
  const multiplier=bond.addVat?baseRate.plus(100).div(100):new D(1),factor=coefficient.times(multiplier);
  if(factor.gte(1))throw new Error('Комиссия БГ не позволяет рассчитать конечную цену');
  gross=beforeBond.div(new D(1).minus(factor)).toDecimalPlaces(2);
  let amount=new D(0),fee=new D(0),price=new D(0),stable=false;
  for(let i=0;i<12;i++){
   amount=gross.times(coverage).div(100).toDecimalPlaces(2);
   fee=amount.times(annual).div(100).times(months).div(12).toDecimalPlaces(2);
   price=fee.times(multiplier).toDecimalPlaces(2);
   const next=beforeBond.plus(price);if(next.eq(gross)){stable=true;break;}gross=next;
  }
  if(!stable)throw new Error('Не удалось согласовать округление комиссии БГ и итоговой цены');
  vat=vat.plus(bond.addVat?price.minus(fee):price.times(baseRate).div(baseRate.plus(100)).toDecimalPlaces(2));
  Object.assign(fields,{kp_total_before_bond:formatPacketMoney(beforeBond.toFixed(2)),performance_bond_amount:formatPacketMoney(amount.toFixed(2)),performance_bond_bank_fee:formatPacketMoney(fee.toFixed(2)),performance_bond_price_addition:formatPacketMoney(price.toFixed(2)),performance_bond_clause:`Банковская гарантия обеспечения исполнения Работ (Performance bond) предоставляется в размере ${coverage.toFixed().replace('.',',')}% полной стоимости Договора, включая номинированные разделы и генподрядное вознаграждение. Срок — ${months.toFixed().replace('.',',')} мес. строительства.`});
  issues.push('Стоимость БГ рассчитана предварительно по согласованному тарифу; предложение банка и условия выдачи не приложены');
 }
 const total=gross.toFixed(2),tax=vat.toFixed(2);
 return {fields:{...fields,kp_total:formatPacketMoney(total),total_words:moneyWords(total),vat_amount:formatPacketMoney(tax),vat_words:moneyWords(tax),nomination_total:formatPacketMoney(addition.toFixed(2))},issues,addition:addition.toFixed(2),total};
};
