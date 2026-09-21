// Минимальный генератор ZIP для тестов: позволяет создать заведомо опасные архивы
// (../, абсолютные пути, ссылки, ложные размеры, шифрование), которые обычные библиотеки не пишут.
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export interface IZipEntry {
  name: string | Buffer;
  data: Buffer;
  deflate?: boolean;
  utf8?: boolean;
  symlink?: boolean;
  encrypted?: boolean;
  // Подмена заявленного распакованного размера (проверка лимитов по заголовку и по факту).
  declaredSize?: number;
}

export const buildZip = (entries: IZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, e.utf8 === false ? 'latin1' : 'utf8') : e.name;
    const utf8 = typeof e.name === 'string' && e.utf8 !== false;
    // Зашифрованный элемент ZipCrypto начинается с 12-байтового заголовка шифрования.
    const raw = e.deflate ? deflateRawSync(e.data) : e.data;
    const body = e.encrypted ? Buffer.concat([Buffer.alloc(12, 0x5a), raw]) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const flags = (utf8 ? 0x800 : 0) | (e.encrypted ? 0x1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.symlink ? 0x031e : 20, 4); // «создан в UNIX» для атрибутов режима
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};

// Синтетические файлы с правильными сигнатурами.
export const fakePdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'utf8');
export const fakePng = (): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

export interface IPdfPage {
  rotate?: number;
  width?: number;
  height?: number;
}

/**
 * Настоящий минимальный PDF: каталог, дерево страниц с /Rotate, поток содержимого и
 * корректная таблица xref. Нужен там, где файл действительно разбирается — просмотр
 * участка доказательства на pdf.js. Для проверок импорта достаточно fakePdf.
 */
export const realPdf = (pages: IPdfPage[], label = ''): Buffer => {
  // Метка делает содержимое разных документов различным: иначе две фикстуры с одинаковым
  // числом страниц дали бы один SHA-256 и, значит, одну редакцию на тендер.
  const tag = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 16);
  const bodies: string[] = [];
  const pageObjNo = (i: number): number => 3 + i * 2;
  const kids = pages.map((_, i) => `${pageObjNo(i)} 0 R`).join(' ');
  bodies.push('<< /Type /Catalog /Pages 2 0 R >>');
  bodies.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => {
    const w = page.width ?? 595;
    const h = page.height ?? 842;
    const content = `% ${tag} p${i}\n0.86 0.88 0.9 rg 20 20 ${w - 40} ${h - 40} re f\n0 0 0 RG 2 w 40 40 ${w - 80} ${h - 80} re S\n`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${page.rotate ?? 0} /Resources << >> /Contents ${pageObjNo(i) + 1} 0 R >>`,
    );
    bodies.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  });

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  bodies.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(chunk);
    size += chunk.length;
  });
  const xrefOffset = size;
  const xref = [`xref\n0 ${bodies.length + 1}\n`, '0000000000 65535 f \n'];
  for (const offset of offsets) xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  parts.push(Buffer.from(xref.join(''), 'latin1'));
  parts.push(Buffer.from(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
};
