// S18-14 OPEN. Diagnostic regression: the first three cases must fail on the current rule.
// Run explicitly with node --test; no DB, model or customer data is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runRuleChecks,DEFAULT_SOURCE_PRIORITY} from '../packages/core/src/index.ts';

const findings=text=>runRuleChecks({
 priority:DEFAULT_SOURCE_PRIORITY,units:[],importsPending:0,registry:null,
 calculationRevisionId:null,calcObjects:new Map(),positions:[],requirements:[],
 fragments:[{fragmentId:'synthetic-context',text,origin:'document_text',hasAssumption:false}],
 fragmentsTotal:1,facts:[],factConflicts:[],newerRevisions:new Map(),questions:[],factsPendingUnits:0,
}).findings.filter(f=>f.kind==='pd_uncertainty');

test('S18-14: термин ОДК не означает отложенный проектный объём',()=>{
 assert.equal(findings('ОДК — ориентировочно допустимые концентрации веществ в почве.').length,0);
});
test('S18-14: перечень томов на согласование не является отложенной величиной',()=>{
 assert.equal(findings('Региональное управление определяет перечень томов проектной и рабочей документации, подлежащих согласованию.').length,0);
});
test('S18-14: уведомление о прибытии груза — определённая процедура',()=>{
 assert.equal(findings('Подрядчик уведомляет об ориентировочном времени прибытия груза за 15 суток, точное время сообщает за сутки.').length,0);
});
test('контроль: количество оборудования на РД требует решения',()=>{
 assert.equal(findings('Количество оборудования уточняется на стадии рабочей документации.').length,1);
});
test('контроль: ориентировочная стоимость изделия требует решения',()=>{
 assert.equal(findings('Стоимость индивидуального изделия дана ориентировочно и требует расчёта конструктива.').length,1);
});
test('контроль: определённое количество не создаёт предупреждение',()=>{
 assert.equal(findings('Спецификация: светильники, 20 шт.').length,0);
});
