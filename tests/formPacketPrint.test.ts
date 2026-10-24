import {it,expect} from 'vitest';
import PizZip from 'pizzip';
import {renderXlsx} from '../packages/adapters/src/office/render.ts';
import {openPackage,writePackage} from '../packages/adapters/src/office/ooxml.ts';
const fixture=(fit:boolean)=>{
 const z=new PizZip();
 z.file('[Content_Types].xml','<Types/>');
 z.file('xl/workbook.xml',`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Условия" sheetId="1" r:id="rId1"/></sheets>${fit?'<definedNames><definedName name="_KonturFitRows">1</definedName></definedNames>':''}</workbook>`);
 z.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
 z.file('xl/styles.xml','<styleSheet><fonts><font><b val="1"/><sz val="10"/><name val="Arial"/></font></fonts><cellXfs><xf fontId="0"><alignment wrapText="1"/></xf></cellXfs></styleSheet>');
 z.file('xl/worksheets/sheet1.xml','<worksheet><cols><col min="1" max="2" width="12"/></cols><sheetData><row r="1" ht="15"><c r="A1" t="inlineStr"><is><t>{{terms}}</t></is></c></row><row r="2"/></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells><pageSetup paperSize="8" fitToWidth="1" fitToHeight="1"/></worksheet>');
 return writePackage(z);
};
const terms='Подробные условия выполнения и приёмки работ. '.repeat(6);
it('помеченный шаблон увеличивает высоту длинного текста, сохраняя А3, шрифты и объединения',()=>{
 const original=fixture(true),before=Buffer.from(original),zip=openPackage(renderXlsx(original,{terms},new Set(),[]));
 const xml=zip.file('xl/worksheets/sheet1.xml')!.asText();
 expect(Number(/<row r="1"[^>]*?\bht="([\d.]+)"/u.exec(xml)?.[1])).toBeGreaterThan(15);
 expect(xml).toContain(terms);expect(xml).toContain('<row r="2"/>');
 expect(xml).toContain('<mergeCell ref="A1:B1"/>');expect(xml).toContain('paperSize="8" fitToWidth="1" fitToHeight="1"');
 expect(zip.file('xl/styles.xml')!.asText()).toBe(openPackage(original).file('xl/styles.xml')!.asText());expect(original).toEqual(before);
});
it('обычный шаблон сохраняет прежние высоты, чрезмерный текст отклоняется явно',()=>{
 expect(openPackage(renderXlsx(fixture(false),{terms},new Set(),[])).file('xl/worksheets/sheet1.xml')!.asText()).toContain('<row r="1" ht="15">');
 expect(()=>renderXlsx(fixture(true),{terms:terms.repeat(100)},new Set(),[])).toThrow('не помещается');
});
