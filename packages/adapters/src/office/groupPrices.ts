// Производная печатная копия: только явно проверенные групповые строки, источник не изменяется.
import { openPackage, sheets, writePackage, OfficeError } from './ooxml.ts';
export const blankGroupUnitPrices = (bytes: Buffer, rows: readonly number[]): Buffer => {
  const zip = openPackage(bytes);
  const wanted = new Set(rows);
  let changed = 0;
  for (const sheet of sheets(zip)) {
    const file = zip.file(sheet.part);
    if (!file) continue;
    let xml = file.asText();
    for (const row of wanted) {
      const quantity = new RegExp(`<c\\b[^>]*\\br="J${row}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`, 'u').exec(xml)?.[0] ?? '';
      if (/<f\b/u.test(quantity)||/<v\b[^>]*>\s*[^<\s]/u.test(quantity)||/<t\b[^>]*>\s*[^<\s]/u.test(quantity)) throw new OfficeError('render_failed', `J${row}: количество заполнено`);
      for (const col of ['K','L','M','N']) {
        const re = new RegExp(`<c\\b([^>]*\\br="${col}${row}"[^>]*)>([\\s\\S]*?)</c>`, 'u');
        const m = re.exec(xml);
        if (!m || !m[2]!.includes('#DIV/0!')) continue;
        const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/u.exec(m[2]!)?.[1];
        if (!f || !new RegExp(`\\bJ${row}\\b`, 'u').test(f)) throw new OfficeError('render_failed', `${col}${row}: неизвестная причина ошибки`);
        const attrs = m[1]!.replace(/\s+t="[^"]*"/u, '');
        xml = xml.replace(re, `<c${attrs} t="str"><f>IF(ISBLANK(J${row}),&quot;&quot;,${f})</f><v></v></c>`);
        changed += 1;
      }
    }
    zip.file(sheet.part, xml);
  }
  if (changed !== wanted.size * 4) throw new OfficeError('render_failed', 'Набор ошибок не совпадает с проверенными четырьмя удельными ценами каждой группы');
  return writePackage(zip);
};
