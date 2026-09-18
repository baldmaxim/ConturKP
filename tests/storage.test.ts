// Хранилище по содержимому (ADR-003) и правила типов/путей без БД.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { classifyFile, nameKeyOf, safeRelativePath } from '../packages/core/src/index.ts';
import { BlobLimitError, BlobStore } from '../packages/storage/src/index.ts';

const newStore = async () => {
  const s = new BlobStore(mkdtempSync(join(tmpdir(), 'kontur-store-')));
  await s.init();
  return s;
};

describe('BlobStore', () => {
  it('ключ по SHA-256, дедупликация, «только чтение», повтор не перезаписывает', async () => {
    const store = await newStore();
    const data = Buffer.from('содержимое');
    const a = await store.putStream(Readable.from([data]), 1024);
    expect(a.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(a.created).toBe(true);
    expect(a.storageKey).toBe(`sha256/${a.sha256.slice(0, 2)}/${a.sha256.slice(2, 4)}/${a.sha256}`);
    const mtime = statSync(store.pathOf(a.sha256)).mtimeMs;
    const b = await store.putStream(Readable.from([data]), 1024);
    expect(b.created).toBe(false);
    expect(statSync(store.pathOf(a.sha256)).mtimeMs).toBe(mtime);
    expect(statSync(store.pathOf(a.sha256)).mode & 0o200).toBe(0);
    expect(await store.verify(a.sha256)).toBe(true);
    expect(readdirSync(join(store.root, 'tmp'))).toEqual([]);
  });

  it('сбой во время записи: blob не создаётся, временный файл удалён', async () => {
    const store = await newStore();
    const failing = new Readable({
      read() {
        this.push(Buffer.from('часть'));
        this.destroy(new Error('обрыв источника'));
      },
    });
    await expect(store.putStream(failing, 1024)).rejects.toThrow(/обрыв/);
    expect(readdirSync(join(store.root, 'tmp'))).toEqual([]);
    expect(readdirSync(join(store.root, 'sha256'))).toEqual([]);
  });

  it('превышение лимита: запись прерывается, следов нет', async () => {
    const store = await newStore();
    await expect(store.putStream(Readable.from([Buffer.alloc(2048)]), 1024)).rejects.toBeInstanceOf(BlobLimitError);
    expect(readdirSync(join(store.root, 'tmp'))).toEqual([]);
    expect(readdirSync(join(store.root, 'sha256'))).toEqual([]);
  });
});

describe('пути и типы (A38)', () => {
  it('safeRelativePath', () => {
    expect(safeRelativePath('Проект/ТЗ.pdf')).toEqual({ ok: true, path: 'Проект/ТЗ.pdf' });
    expect(safeRelativePath('a\\b\\c.pdf')).toEqual({ ok: true, path: 'a/b/c.pdf' });
    expect(safeRelativePath('./a//b.pdf')).toEqual({ ok: true, path: 'a/b.pdf' });
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\x', 'c:x', 'dir/NUL.txt', 'a\u0000b', 'a:b', '']) {
      expect(safeRelativePath(bad).ok, bad).toBe(false);
    }
  });

  it('classifyFile по сигнатуре и расширению', () => {
    const pdf = Buffer.from('%PDF-1.7');
    expect(classifyFile('a.pdf', pdf, 10)).toEqual({ kind: 'document', mediaType: 'application/pdf' });
    expect(classifyFile('a.PDF', pdf, 10).kind).toBe('document');
    expect(classifyFile('a.txt', pdf, 10).kind).toBe('rejected');
    expect(classifyFile('a.zip', Buffer.from([0x50, 0x4b, 3, 4]), 10).kind).toBe('archive');
    expect(classifyFile('a.docx', Buffer.from([0x50, 0x4b, 3, 4]), 10).kind).toBe('document');
    expect(classifyFile('a.jar', Buffer.from([0x50, 0x4b, 3, 4]), 10).kind).toBe('rejected');
    expect(classifyFile('a.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 10).kind).toBe('document');
    expect(classifyFile('a.dwg', Buffer.from('AC1032'), 10).kind).toBe('document');
    expect(classifyFile('a.csv', Buffer.from('a;b\n1;2'), 7).kind).toBe('document');
    expect(classifyFile('a.csv', Buffer.from([0x61, 0, 0x62]), 3)).toMatchObject({ kind: 'rejected', reason: 'corrupt' });
    expect(classifyFile('noext', Buffer.from('x'), 1)).toMatchObject({ kind: 'rejected', reason: 'type_not_allowed' });
  });

  it('ключ группировки редакций по имени', () => {
    expect(nameKeyOf('Папка/ТЗ  Итог.PDF')).toBe('тз итог.pdf');
  });
});
