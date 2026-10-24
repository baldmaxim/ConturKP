import {it,expect} from 'vitest';
import {packetMoney,moneyWords,checkCalculationTotals,type INomination} from '../apps/server/src/formPacketMoney.ts';
import {blankGroupUnitPrices} from '../packages/adapters/src/office/groupPrices.ts';
import {openPackage,writePackage} from '../packages/adapters/src/office/ooxml.ts';
import PizZip from 'pizzip';
const row=(patch:Partial<INomination>={}):INomination=>({key:'nom1',title:'Раздел',amount:'122',vatIncluded:true,vatRate:'22',gpPercent:'14',...patch});
it('расход БГ согласован с конечной ценой, НДС добавляется один раз, генподряд сверху не начисляется',()=>{
 const b={coveragePercent:'3',annualRatePercent:'3',months:'30',addVat:true};
 const result=packetMoney('1000','22',[],b);
 expect(result.total).toBe('1002.76');expect(result.fields.performance_bond_amount).toBe('30,08');
 expect(result.fields.performance_bond_bank_fee).toBe('2,26');expect(result.fields.performance_bond_price_addition).toBe('2,76');
 expect(result.fields.nomination_total).toBe('0,00');expect(result.issues.join()).toContain('предварительно');
 expect(packetMoney('1000','22',[],{...b,addVat:false}).total).toBe('1002.26');
 expect(()=>packetMoney('1000','22',[],{...b,coveragePercent:'100',annualRatePercent:'100',months:'12'})).toThrow('конечную цену');
});
it('явно различает итог шапки и сумму позиций, допускает только копейку округления',()=>{
 expect(checkCalculationTotals('1234567890.12','1190271785.517341').reconciled).toBe(false);
 expect(checkCalculationTotals('1234567890.12','1190271785.517341').differenceDisplay).toBe('44 296 104,60');
 expect(checkCalculationTotals('100','100.009').reconciled).toBe(true);
 expect(checkCalculationTotals('100','100.011').reconciled).toBe(false);
});
it('прибавляет номинацию и генподряд один раз, не начисляя повторно включённый НДС',()=>{
 const result=packetMoney('1000','22',[row()]);expect(result.total).toBe('1139.08');expect(result.addition).toBe('139.08');
 expect(result.fields.kp_total).toBe('1 139,08');expect(result.fields.nominations_list).toContain('включая НДС');
});
it('рассчитывает стоимость без НДС и отдельный нулевой процент',()=>{
 expect(packetMoney('1000','22',[row({amount:'100',vatIncluded:false})]).total).toBe('1139.08');
 expect(packetMoney('1000','22',[row({gpPercent:'0'})]).total).toBe('1122.00');
 expect(packetMoney('1000','22',[row({amount:'0',gpPercent:'0'})]).total).toBe('1000.00');
});
it('не придумывает базу НДС, не подменяет неизвестное нулём',()=>{
 const result=packetMoney('1000','22',[row({vatIncluded:null})]);expect(result.total).toBeNull();expect(result.issues.join()).toContain('Не определена база НДС');
 expect(()=>packetMoney('1000','22',[row({amount:''})])).toThrow('число');
});
it('пропись выведена из суммы с округлением, грамматикой тысяч и копеек',()=>{
 expect(moneyWords('1001.02')).toBe('Одна тысяча один рубль две копейки');
 expect(moneyWords('21000.115')).toBe('Двадцать одна тысяча рублей двенадцать копеек');
 expect(moneyWords('0')).toBe('Ноль рублей ноль копеек');
});
const book=(quantity='')=>{
 const z=new PizZip();
 z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
 z.file('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Оферта" sheetId="1" r:id="rId1"/></sheets></workbook>');
 z.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
 z.file('xl/worksheets/sheet1.xml',`<worksheet><sheetData><row r="5"><c r="J5">${quantity}</c>${['K','L','M','N'].map(c=>`<c r="${c}5" t="e"><f>O5/J5</f><v>#DIV/0!</v></c>`).join('')}</row></sheetData><pageSetup paperSize="8" fitToWidth="1"/></worksheet>`);
 z.file('xl/styles.xml','<styleSheet>preserved</styleSheet>');return writePackage(z);
};
it('исправляет только четыре проверенных групповых ячейки, сохраняя источник, стили и печать',()=>{
 const original=book(),before=Buffer.from(original),result=blankGroupUnitPrices(original,[5]);expect(original).toEqual(before);
 const z=openPackage(result);expect(z.file('xl/styles.xml')!.asText()).toBe('<styleSheet>preserved</styleSheet>');
 expect(z.file('xl/worksheets/sheet1.xml')!.asText()).toContain('IF(ISBLANK(J5),&quot;&quot;,O5/J5)');
 expect(z.file('xl/worksheets/sheet1.xml')!.asText()).toContain('<pageSetup paperSize="8" fitToWidth="1"/>');
});
it('не скрывает деление при нулевом количестве и несовпадение списка строк',()=>{
 expect(()=>blankGroupUnitPrices(book('<v>0</v>'),[5])).toThrow('количество заполнено');
 expect(()=>blankGroupUnitPrices(book(),[6])).toThrow('не совпадает');
});
it('пустая сокращённая XML-ячейка не поглощает следующую ячейку с ошибкой',()=>{
 const zip=openPackage(book());zip.file('xl/worksheets/sheet1.xml',zip.file('xl/worksheets/sheet1.xml')!.asText().replace('<c r="J5"></c>','<c r="J5" s="49"/>'));
 expect(()=>blankGroupUnitPrices(writePackage(zip),[5])).not.toThrow();
});
