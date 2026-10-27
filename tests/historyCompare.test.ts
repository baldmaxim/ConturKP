import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {compareHistoryBuffers as compare} from '../packages/adapters/src/local/historyCompare.ts';
import {buildDocx,buildXlsx} from './ooxmlFixtures.ts';
const b=(s:string)=>Buffer.from(s);
describe('сравнение содержимого сохранённых версий',()=>{
 it('показывает вставку без каскада изменений остальных строк',async()=>{
  const r=await compare('a.txt',b('Первый\nПоследний'),b('Первый\nВставка\nПоследний'));
  expect(r.status).toBe('ready');expect(r.changes).toHaveLength(1);expect(r.changes[0]).toMatchObject({kind:'added',before:null,after:'Вставка'});
 });
 it('совмещает повторяющиеся строки и различает замену, удаление и известное отсутствие',async()=>{
  const r=await compare('a.txt',b('a\nx\na\ny'),b('a\nx\na\nz'));expect(r.changes).toHaveLength(1);expect(r.changes[0]).toMatchObject({before:'y',after:'z'});
  expect((await compare('a.txt',b('abc'),null)).changes[0]).toMatchObject({kind:'removed',before:'abc',after:null});
  expect((await compare('a.txt',null,b('abc'))).changes[0]).toMatchObject({kind:'added',before:null,after:'abc'});
 });
 it('читает Windows-1251 и UTF-16 без потери русского текста',async()=>{
  const cp=Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]);
  expect((await compare('a.txt',cp,b('Привет'))).changes).toEqual([]);
  expect((await compare('a.txt',Buffer.concat([Buffer.from([255,254]),Buffer.from('Привет','utf16le')]),b('Привет'))).changes).toEqual([]);
 });
 it('сравнивает текст DOCX, таблицы и колонтитулы',async()=>{
  const doc=(value:string)=>buildDocx({blocks:[{p:'Заголовок'},{table:[['Цена',value]]}],header:'Договор '+value});
  const r=await compare('a.docx',doc('100'),doc('200'));
  expect(r.status,JSON.stringify(r)).toBe('ready');expect(JSON.stringify(r.changes)).toContain('100');expect(JSON.stringify(r.changes)).toContain('200');expect(JSON.stringify(r.changes)).toContain('Договор');
 });
 it('сравнивает адреса XLSX и изменение формулы при одинаковом сохранённом результате',async()=>{
  const sheet=(f:string,value:string)=>buildXlsx([{name:'Смета',cells:[{ref:'A1',v:value},{ref:'B2',f,cached:10}]}]);
  const r=await compare('a.xlsx',sheet('5+5','Было'),sheet('2*5','Стало'));
  expect(r.status,JSON.stringify(r)).toBe('ready');expect(r.format).toBe('cells');expect(r.changes.map(c=>c.location)).toEqual(['Смета · A1','Смета · B2']);
  expect(r.changes[1]).toMatchObject({before:'Формула: 5+5\nСохранённое значение: 10',after:'Формула: 2*5\nСохранённое значение: 10'});
 });
 it('повреждённый DOCX не считается совпадающим текстом',async()=>{
  const r=await compare('a.docx',b('broken'),b('broken'));expect(r.status).toBe('unreadable');expect(r.warnings.length).toBeGreaterThan(0);
 });
 it('показывает ограничение сканированного PDF и не обещает полное сравнение',async()=>{
  const scan=readFileSync('tests/fixtures/local/letter-scan.pdf');const r=await compare('a.pdf',scan,scan);
  expect(r.status,JSON.stringify(r)).toBe('partial');expect(r.format).toBe('pdf');expect(r.warnings.join(' ')).toContain('без доступного текста');
 });
 it('ограничивает объём результата явно, не прячет изменения за совпадением',async()=>{
  const a=Array.from({length:700},(_,i)=>'same-'+i).join('\n'),next=Array.from({length:700},(_,i)=>'changed-'+i+'\nsame-'+i).join('\n');
  const r=await compare('a.txt',b(a),b(next));expect(r.truncated).toBe(true);expect(r.changes).toHaveLength(600);expect(r.stats.added).toBe(700);
 });
 it('не разбирает неподдерживаемые форматы как текст',async()=>{
  expect((await compare('a.dwg',b('x'),b('y'))).status).toBe('unsupported');
 });
});
