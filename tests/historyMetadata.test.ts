import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,sep,basename} from 'node:path';
import {afterAll,describe,expect,it} from 'vitest';
import {historyDocumentEditor,readHistoryDocumentEditor} from '../packages/adapters/src/local/historyMetadata.ts';
import {buildZip} from './ooxmlFixtures.ts';
const root=mkdtempSync(join(tmpdir(),'history-editor-'));
afterAll(()=>{const target=resolve(root);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('history-editor-'))throw Error('Unexpected temporary directory');rmSync(target,{recursive:true,force:true});});
const xml=(body:string,prefix='cp')=>Buffer.from('<'+prefix+':coreProperties xmlns:'+prefix+'="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'+body+'</'+prefix+':coreProperties>');
describe('последний редактор сохранённого документа',()=>{
 it('читает именно последнего редактора, поддерживает имена пространств и XML-сущности',()=>{expect(historyDocumentEditor(xml('<meta:lastModifiedBy> Иван &amp; Пётр </meta:lastModifiedBy>','meta'))).toBe('Иван & Пётр');});
 it('не подменяет редактора создателем документа и отвергает неоднозначность',()=>{expect(historyDocumentEditor(xml('<dc:creator>Создатель</dc:creator>'))).toBe(null);expect(historyDocumentEditor(xml('<cp:lastModifiedBy>A</cp:lastModifiedBy><cp:lastModifiedBy>B</cp:lastModifiedBy>'))).toBe(null);});
 it('не выполняет объявления XML и ограничивает размер свойств',()=>{expect(historyDocumentEditor(Buffer.from('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]>'+xml('<cp:lastModifiedBy>&x;</cp:lastModifiedBy>')))).toBe(null);expect(historyDocumentEditor(Buffer.alloc(65537))).toBe(null);});
 it('читает только небольшую часть свойств из сохранённого ZIP',async()=>{const path=join(root,'version');writeFileSync(path,buildZip([{name:'word/document.xml',data:'x'.repeat(200000)},{name:'docProps/core.xml',data:xml('<cp:lastModifiedBy>Мария Иванова</cp:lastModifiedBy>')} ]));expect(await readHistoryDocumentEditor('Условия.docx',path)).toBe('Мария Иванова');});
 it('честно возвращает отсутствие имени для неподдерживаемого, повреждённого или неполного файла',async()=>{const path=join(root,'unknown');writeFileSync(path,buildZip([{name:'docProps/core.xml',data:xml('<dc:creator>Владелец</dc:creator>')} ]));expect(await readHistoryDocumentEditor('x.xlsx',path)).toBe(null);expect(await readHistoryDocumentEditor('x.pdf','does-not-exist')).toBe(null);writeFileSync(path,'broken');expect(await readHistoryDocumentEditor('x.docx',path)).toBe(null);});
});
