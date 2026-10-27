import {describe,expect,it} from 'vitest';
import {historyBackground,historyDate,historyTime,historySourceKey,historySubject} from '../apps/web/src/pages/history/historyPresentation.ts';
describe('представление изменений',()=>{
 it('считает обновляемые папки один раз при двух способах обновления',()=>{
  const summary={watch:[{bindingId:'a',enabled:true,lastSuccessAt:'2026-10-24T08:00:00Z',lastErrorCode:null},{bindingId:'b',enabled:true,lastSuccessAt:null,lastErrorCode:'offline'}],sync:[{bindingId:'a',enabled:true,lastSuccessAt:'2026-10-24T08:05:00Z',lastErrorCode:null},{bindingId:'b',enabled:true,lastSuccessAt:null,lastErrorCode:'offline'},{bindingId:'c',enabled:false,lastSuccessAt:null,lastErrorCode:'old'}]};
  expect(historyBackground(summary)).toEqual({enabled:2,failed:1,lastSuccess:'2026-10-24T08:05:00Z'});
 });
 it('время показывается без повторения часового пояса и сохраняет местный час',()=>{
  expect(historyTime('2026-10-24T08:05:00Z')).toBe('11:05');expect(historyDate('2026-10-24T08:05:00Z')).not.toContain('МСК');expect(historyTime(null)).toBe('—');
 });
 it('узлы называют конкретный файл и не объединяют общие папки',()=>{
  const a={tenderId:null,folderName:'Условия',sourcePath:'редакции\\Условия ГП.docx',title:'Изменение'};
  expect(historySubject(a)).toBe('Условия ГП.docx');expect(historySourceKey(a)).not.toBe(historySourceKey({...a,folderName:'Шаблоны'}));
 });
});
