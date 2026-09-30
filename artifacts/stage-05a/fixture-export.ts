// Выгрузка фикстур 05a в каталог — для проверки стандартными разборщиками (решение владельца по XLSX,
// D-024): node artifacts/stage-05a/fixture-export.ts <каталог>; затем fixture-open-check.py.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractDocx, csvCp1251, edgeXlsx, smetaStromynkaXlsx } from '../../tests/localFixtures.ts';

const dir = process.argv[2];
if (!dir) throw new Error('укажите каталог');
writeFileSync(join(dir, 'smeta-stromynka.xlsx'), smetaStromynkaXlsx());
writeFileSync(join(dir, 'edge.xlsx'), edgeXlsx());
writeFileSync(join(dir, 'contract.docx'), contractDocx());
writeFileSync(join(dir, 'cp1251.csv'), csvCp1251());
