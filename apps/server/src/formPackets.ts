// Проверочный комплект: один набор параметров, отдельные редакции документов и неизменные снимки.
// Он не является кандидатом выпуска и не заменяет согласование / проверки этапов 12–18.
import { z } from 'zod';
import { allFields, validateSchema, validateValue, type IFormSchema } from '@kontur/core';
import { packetMoney,formatPacketMoney } from './formPacketMoney.ts';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
export const PacketInput = z.object({
  definition: z.object({
    schema: z.unknown(),
    recipes: z.record(key, z.string().max(100_000)),
    recipeVariants: z.partialRecord(z.enum(['inflation','basket','inflation_basket']), z.record(key,z.string().max(100_000))).default({}),
    outputs: z.array(z.object({ revisionId: z.uuid(), name: z.string().min(1).max(200), mechanism: z.string().optional() }).strict()).max(12),
  }).strict(),
  values: z.record(key, z.string().max(100_000)),
  calculationRevisionId:z.uuid().nullable().default(null),
  calculationInsurance:z.object({calculationRevisionId:z.uuid(),amount:z.string().regex(/^\d+(?:[.,]\d{1,2})?$/u).max(40),basis:z.string().trim().min(10).max(2000)}).strict().optional(),
  performanceBond:z.object({coveragePercent:z.string().max(20),annualRatePercent:z.string().max(20),months:z.string().max(20),addVat:z.boolean()}).strict().nullable().default(null),
  nominations:z.array(z.object({key,title:z.string().min(1).max(500),amount:z.string().max(40),vatIncluded:z.boolean().nullable(),vatRate:z.string().max(20),gpPercent:z.string().max(20)}).strict()).max(100).default([]),
  notes: z.string().max(20_000).default(''),
  positions: z.array(z.object({ key, text: z.string().max(20_000), sourceId: z.uuid().nullable(), confirmed: z.boolean() }).strict()).max(100).default([]),
  attachments: z.array(z.object({ sourceId: z.uuid(), blankUnitPriceRows: z.array(z.number().int().min(1).max(1048576)).max(200).optional() }).strict()).max(50).default([]),
}).strict();
export type IPacketInput = z.infer<typeof PacketInput>;
export interface ICompiledPacket { data: Record<string, string>; numbers: Set<string>; issues: string[]; schema: IFormSchema }

const REF = /\[\[([a-z][a-z0-9_]{0,63})\]\]/gu;
export const compilePacket = (input: IPacketInput): ICompiledPacket => {
  if(input.calculationInsurance&&input.calculationInsurance.calculationRevisionId!==input.calculationRevisionId)throw new Error('Расшифровка страхования должна относиться к закреплённой ревизии расчёта');
  const checked = validateSchema(input.definition.schema);
  if (!checked.ok) throw new Error(checked.issues.map(x => `${x.path}: ${x.message}`).join('; '));
  const schema = checked.schema;
  const definitions = new Map(allFields(schema).map(f => [f.key, f]));
  const data: Record<string, string> = Object.create(null) as Record<string, string>;
  const numbers = new Set<string>();
  const issues: string[] = [];
  for (const k of Object.keys(input.values)) if (!definitions.has(k)) throw new Error(`Неизвестное поле: ${k}`);
  for (const field of definitions.values()) {
    const raw = input.values[field.key] ?? '';
    if (!raw.trim()) {
      if (field.required === true) issues.push(`Не заполнено: ${field.label}`);
      data[field.key] = '';
      continue;
    }
    const v = validateValue(field, raw);
    if (!v.ok) throw new Error(`${field.label}: ${v.errors.join('; ')}`);
    if (typeof v.value !== 'string') throw new Error(`${field.label}: комплект поддерживает скалярные поля`);
    if (field.type === 'date') data[field.key] = v.value.split('-').reverse().join('.');
    else if (field.type === 'number') { data[field.key] = v.value.replace('.', ','); numbers.add(field.key); }
    else if (field.type === 'choice') data[field.key] = field.options.find(o => o.value === v.value)?.label ?? v.value;
    else data[field.key] = v.value;
  }
  if(input.values.th_total){
    if(!input.values.vat_rate)throw new Error('Укажите основную ставку НДС');
    if(new Set(input.nominations.map(n=>n.key)).size!==input.nominations.length)throw new Error('Номинированные строки имеют повторяющиеся идентификаторы');
    const money=packetMoney(input.values.th_total,input.values.vat_rate,input.nominations,input.performanceBond?{...input.performanceBond,months:input.values.c09_months_to_zos??input.performanceBond.months}:null);
    Object.assign(data,money.fields);issues.push(...money.issues);
    if(input.values.reference_total&&money.total&&formatPacketMoney(input.values.reference_total)!==money.fields.kp_total)issues.push(`Текущий итог ${money.fields.kp_total} руб. отличается от исторического ${formatPacketMoney(input.values.reference_total)} руб.; сверить состав расчёта и оферту перед согласованием`);
  }
  for(const k of ['contract_number','contract_date','method_contract_annex'])if(definitions.has(k)&&(!input.values[k]||input.values[k]!.startsWith('[')))issues.push(`Не согласовано: ${definitions.get(k)!.label}`);
  const referenceKeys=new Set(Object.keys(data));
  const variants:Record<string,Record<string,string>|undefined>=input.definition.recipeVariants;
  const recipes={...input.definition.recipes,...variants[input.values.c08_mechanism??'']};
  for (const [k, recipe] of Object.entries(recipes)) {
    if (definitions.has(k)) throw new Error(`Поле и формулировка имеют один ключ: ${k}`);
    for (const m of recipe.matchAll(REF)) if (!referenceKeys.has(m[1]!)) throw new Error(`Неизвестная ссылка в ${k}: ${m[1]}`);
    // Однократная подстановка: текст значения не становится шаблоном или кодом.
    data[k] = recipe.replace(REF, (_m, ref: string) => data[ref] ?? '');
  }
  for (const k of Object.keys(data)) if (/^c\d{2}_customer$/u.test(k)) data[k] = '';
  for (const p of input.positions) {
    if (!/^c\d{2}_customer$/u.test(p.key)) throw new Error('Позиция заказчика должна ссылаться на пункт условий');
    if (p.confirmed && !p.sourceId) throw new Error(`У подтверждённой позиции ${p.key} нет источника`);
    if (!p.confirmed && p.text.trim()) issues.push(`Позиция заказчика не подтверждена: ${p.key}`);
    data[p.key] = p.confirmed ? p.text : '';
  }
  return { data, numbers, issues, schema };
};

export const packetChanges = (before: IPacketInput | null, after: IPacketInput): string[] => {
  if (!before) return Object.keys(after.values);
  const changed = Object.keys({ ...before.values, ...after.values }).filter(k => before.values[k] !== after.values[k]);
  if (JSON.stringify(before.definition) !== JSON.stringify(after.definition)) changed.push('definition');
  if (JSON.stringify(before.positions) !== JSON.stringify(after.positions)) changed.push('positions');
  if (JSON.stringify(before.attachments) !== JSON.stringify(after.attachments)) changed.push('attachments');
  if (before.notes !== after.notes) changed.push('notes');
  if (JSON.stringify(before.nominations) !== JSON.stringify(after.nominations)) changed.push('nominations');
  if (JSON.stringify(before.performanceBond) !== JSON.stringify(after.performanceBond)) changed.push('performanceBond');
  if (JSON.stringify(before.calculationInsurance) !== JSON.stringify(after.calculationInsurance)) changed.push('calculationInsurance');
  return changed;
};
