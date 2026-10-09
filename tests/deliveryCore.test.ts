// Этап 14 — ядро и адаптер размещения без БД (D-034; проект §4–§6; A27, A29, A30, A38): пути и раскладка, набор файлов
// и признак готовности, адаптер FsDeliveryTarget поверх временных папок с внесением отказов. Поддельные назначения.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DeliveryAdapterError, deliveryErrorOf, FsDeliveryTarget, withTimeout } from '../packages/adapters/src/index.ts';
import { nodeDeliveryFs, retryTransientRename } from '../packages/storage/src/index.ts';
import {
  canonicalJson,
  deliveryFilePlan,
  isPathInside,
  placementBytes,
  placementManifestOf,
  placementSha256,
  relativePathProblem,
  releaseFolderPath,
  rootPathProblem,
  sanitizeSegment,
  segmentProblem,
} from '../packages/core/src/index.ts';
import { FaultyFs } from './deliveryFixtures.ts';

const RID = '0f8731f0-a628-4adc-a38d-3cdc9aa4f972';

describe('пути (проект §6, A38)', () => {
  it('сегменты: «..», разделители, двоеточие, управляющие, крайние пробелы, конечная точка, зарезервированные имена Windows — отказ', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:x', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b', ' a', 'a ', 'a.', 'CON', 'con.txt', 'Nul.pdf', 'COM1', 'lpt9.docx', 'x'.repeat(121)]) {
      expect(segmentProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const ok of ['01 Письмо КП.pdf', 'Выпуск 3 0f8731f0', 'CONTUR.pdf', 'com10.txt', 'manifest.json', 'x'.repeat(120)]) expect(segmentProblem(ok), ok).toBeNull();
  });

  it('путь относительно корня: только «/», не абсолютный, каждый сегмент допустим, не длиннее 240', () => {
    expect(relativePathProblem('A-1/Этап 1/Выпуск 2 0f8731f0')).toBeNull();
    for (const bad of ['', '/A-1', 'C:/A-1', 'A-1\\Этап 1', 'A-1/../x', 'A-1//x', 'A-1/./x', `${'a'.repeat(120)}/${'b'.repeat(120)}/c`]) {
      expect(relativePathProblem(bad), bad).not.toBeNull();
    }
  });

  it('корень и служебная папка: UNC, буква диска или /…; без «..»; вложенность — без учёта регистра у путей Windows и с двойными разделителями', () => {
    for (const ok of ['\\\\srv\\share', '\\\\srv\\share\\Контур КП тест', 'D:\\Яндекс.Диск\\Контур', 'D:/x', '/srv/kontur']) expect(rootPathProblem(ok), ok).toBeNull();
    for (const bad of ['', 'relative', '.\\x', '\\\\srv', 'D:', 'D:x', '/a/../b', 'D:\\a\\..\\b', '\\\\srv\\share\\a:b', '/a\u0000b', `/${'a'.repeat(400)}`]) {
      expect(rootPathProblem(bad), bad).not.toBeNull();
    }
    expect(isPathInside('D:\\Яндекс.Диск\\Контур\\staging', 'd:/яндекс.диск')).toBe(true);
    expect(isPathInside('/a//b/c', '/a/b')).toBe(true);
    expect(isPathInside('\\\\SRV\\Share\\x', '\\\\srv\\share')).toBe(true);
    expect(isPathInside('/a/bc', '/a/b')).toBe(false);
    expect(isPathInside('D:\\kontur-staging', 'D:\\Яндекс.Диск')).toBe(false);
  });

  it('раскладка В-14-4 и очистка кода тендера: «/», «..», зарезервированное имя, длина — без выхода из корня', () => {
    expect(releaseFolderPath({ tenderCode: 'A-1', stageSeq: 2, candidateSeq: 5, releaseId: RID })).toBe('A-1/Этап 2/Выпуск 5 0f8731f0');
    const evil = releaseFolderPath({ tenderCode: '../../Windows/System32', stageSeq: 1, candidateSeq: 1, releaseId: RID });
    expect(relativePathProblem(evil)).toBeNull();
    expect(evil.split('/')).toHaveLength(3);
    expect(sanitizeSegment('..', 'Тендер')).toBe('Тендер');
    expect(sanitizeSegment(' CON ', 'Тендер')).toBe('_CON');
    expect(sanitizeSegment('a:b*c?.', 'Тендер')).toBe('a_b_c_');
    expect(sanitizeSegment('\u0000\u0001', 'Тендер')).toBe('__');
    const long = sanitizeSegment('😀'.repeat(100), 'Тендер');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(segmentProblem(long)).toBeNull();
    expect([...long].every((ch) => ch === '😀')).toBe(true);
  });
});

describe('набор файлов и признак готовности (В-14-3, проект §5.2)', () => {
  const files = [
    { path: '01 Письмо КП.pdf', role: 'document' as const, audience: 'customer' as const, sha256: 'a'.repeat(64), size: 10 },
    { path: '01 Письмо КП (превью).pdf', role: 'preview' as const, audience: 'internal' as const, sha256: 'b'.repeat(64), size: 11 },
    { path: '02 Ключевые условия.docx', role: 'document' as const, audience: 'internal' as const, sha256: 'c'.repeat(64), size: 12 },
  ];
  const manifests = { candidate: { sha256: 'd'.repeat(64), size: 13 }, release: { sha256: 'e'.repeat(64), size: 14 } };

  it('«для заказчика» — без внутренних и превью, без манифестов; «все файлы» — все и оба манифеста', () => {
    expect(deliveryFilePlan('customer', files, manifests).map((f) => f.path)).toEqual(['01 Письмо КП.pdf']);
    expect(deliveryFilePlan('all', files, manifests).map((f) => [f.path, f.kind])).toEqual([
      ['01 Письмо КП.pdf', 'file'],
      ['01 Письмо КП (превью).pdf', 'file'],
      ['02 Ключевые условия.docx', 'file'],
      ['manifest.json', 'manifest'],
      ['release-manifest.json', 'manifest'],
    ]);
  });

  it('признак — каноническая запись без причин решений; отпечаток детерминирован', () => {
    const release = { id: RID, mode: 'test' as const, contentHash: 'f'.repeat(64), releaseManifestSha256: '1'.repeat(64) };
    const m = placementManifestOf(release, 'all', deliveryFilePlan('all', files, manifests));
    expect(placementBytes(m).toString('utf8')).toBe(canonicalJson(m));
    expect(Object.keys(JSON.parse(placementBytes(m).toString('utf8'))).sort()).toEqual(['fileSet', 'files', 'release', 'schema']);
    expect(m.files.map((f) => f.path)).toEqual([...m.files.map((f) => f.path)].sort());
    const again = placementManifestOf(release, 'all', [...deliveryFilePlan('all', files, manifests)].reverse());
    expect(placementSha256(again)).toBe(placementSha256(m));
  });
});

describe('адаптер FsDeliveryTarget (проект §4)', () => {
  const setup = (fs = new FaultyFs(), timeoutMs = 5_000) => {
    const base = mkdtempSync(join(tmpdir(), 'kontur-adapter-'));
    const root = join(base, 'root');
    const staging = join(base, 'staging');
    mkdirSync(root);
    mkdirSync(staging);
    return { base, root, staging, fs, t: new FsDeliveryTarget({ kind: 'smb', rootPath: root, stagingPath: staging, fs, timeoutMs }) };
  };
  const file = (text: string) => {
    const b = Buffer.from(text, 'utf8');
    return { sha256: createHash('sha256').update(b).digest('hex'), size: b.length, open: () => Readable.from([b]) };
  };

  it('ошибки ОС → коды адаптера; повтор — только недоступность и неизвестный исход', () => {
    const e = (code: string, mutating = true) => deliveryErrorOf(Object.assign(new Error(code), { code }), 'операция', mutating);
    expect([e('ENOSPC').code, e('EDQUOT').code, e('EACCES').code, e('EPERM').code, e('EXDEV').code, e('EEXIST').code, e('ENOTEMPTY').code, e('ECONNRESET').code, e('ENOENT').code]).toEqual([
      'NO_SPACE', 'NO_SPACE', 'FORBIDDEN', 'FORBIDDEN', 'CROSS_DEVICE', 'CONFLICT', 'CONFLICT', 'UNAVAILABLE', 'NOT_FOUND',
    ]);
    expect(e('ECONNRESET').retryable).toBe(true);
    expect(e('EACCES').retryable).toBe(false);
    expect(new DeliveryAdapterError('TIMEOUT_UNKNOWN_OUTCOME', 'x').retryable).toBe(true);
    expect(e('ENOENT').message).not.toMatch(/[\\/]/u);
  });

  it('срок ожидания: изменяющая операция — исход неизвестен, чтение — недоступность; сама операция не прерывается', async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r('готово'), 200));
    const m = await withTimeout('запись', 20, slow).catch((x: unknown) => deliveryErrorOf(x, 'запись', true));
    expect((m as DeliveryAdapterError).code).toBe('TIMEOUT_UNKNOWN_OUTCOME');
    const r = await withTimeout('чтение', 20, slow).catch((x: unknown) => deliveryErrorOf(x, 'чтение', false));
    expect((r as DeliveryAdapterError).code).toBe('UNAVAILABLE');
    expect(await withTimeout('быстро', 500, slow)).toBe('готово');
  });

  it('commitFolder: перенос служебной папки целиком; папка выпуска уже есть — target_exists, ничего не заменено', async () => {
    const { root, staging, t } = setup();
    await t.ensureFolder('staging', 'd1');
    await t.putStagingFile('d1/a.txt', file('А'));
    expect(await t.commitFolder('d1', 'T/Этап 1/Выпуск 1 x')).toBe('moved');
    expect(readdirSync(staging)).toEqual([]);
    expect(readFileSync(join(root, 'T', 'Этап 1', 'Выпуск 1 x', 'a.txt'), 'utf8')).toBe('А');
    await t.ensureFolder('staging', 'd2');
    await t.putStagingFile('d2/a.txt', file('Б'));
    expect(await t.commitFolder('d2', 'T/Этап 1/Выпуск 1 x')).toBe('target_exists');
    expect(readFileSync(join(root, 'T', 'Этап 1', 'Выпуск 1 x', 'a.txt'), 'utf8')).toBe('А');
  });

  it('putMarker: без перезаписи — признак уже есть (в том числе появился между проверкой и переносом) — exists, чужой файл цел', async () => {
    const { root, t } = setup();
    mkdirSync(join(root, 'R'));
    expect(await t.putMarker('R', 'kontur-placement.json', 'own', Buffer.from('{"a":1}'))).toBe('written');
    expect(await t.putMarker('R', 'kontur-placement.json', 'own', Buffer.from('{"a":2}'))).toBe('exists');
    expect(readFileSync(join(root, 'R', 'kontur-placement.json'), 'utf8')).toBe('{"a":1}');
    // Гонка: чужой признак появляется после проверки, до переноса — перенос без замены отказывает.
    mkdirSync(join(root, 'S'));
    const inner = nodeDeliveryFs();
    const race = new FsDeliveryTarget({
      kind: 'smb',
      rootPath: root,
      stagingPath: join(root, '..', 'staging'),
      fs: {
        ...inner,
        writeFile: async (p, src, ex) => {
          await inner.writeFile(p, src, ex);
          writeFileSync(join(root, 'S', 'kontur-placement.json'), 'чужой');
        },
      },
    });
    expect(await race.putMarker('S', 'kontur-placement.json', 'own2', Buffer.from('{"a":3}'))).toBe('exists');
    expect(readFileSync(join(root, 'S', 'kontur-placement.json'), 'utf8')).toBe('чужой');
  });

  it('probe: запись, чтение, перенос в корень и обратно, удаление; разные тома — CROSS_DEVICE; ничего не остаётся', async () => {
    const { root, staging, t, fs } = setup();
    await t.probe();
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(staging)).toEqual([]);
    fs.add({ op: 'stat', path: staging, effect: { dev: 424242 }, times: 1 });
    await expect(t.probe()).rejects.toMatchObject({ code: 'CROSS_DEVICE' });
    fs.add({ op: 'rename', effect: { errno: 'EXDEV' }, times: 1 });
    await expect(t.probe()).rejects.toMatchObject({ code: 'CROSS_DEVICE' });
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(staging)).toEqual([]);
  });

  it('removeOwnStaging удаляет только свою служебную папку доставки', async () => {
    const { t } = setup();
    for (const bad of ['', '..', '../root', 'a/b', '.kontur-probe-x']) await expect(t.removeOwnStaging(bad)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

describe('Windows: кратковременная блокировка файла при переносе', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it('на Windows EPERM/EACCES/EBUSY повторяются, пока имя назначения свободно; на других системах и при занятом имени — ошибка сразу', async () => {
    let n = 0;
    await retryTransientRename(async () => {
      n += 1;
      if (n < 3) throw busy(n === 1 ? 'EPERM' : 'EBUSY');
    }, async () => false, 'win32', [1, 1, 1]);
    expect(n).toBe(3);
    let m = 0;
    await expect(retryTransientRename(async () => {
      m += 1;
      throw busy('EPERM');
    }, async () => false, 'linux', [1, 1, 1])).rejects.toMatchObject({ code: 'EPERM' });
    expect(m).toBe(1);
    let k = 0;
    await expect(retryTransientRename(async () => {
      k += 1;
      throw busy('EPERM');
    }, async () => true, 'win32', [1, 1, 1])).rejects.toMatchObject({ code: 'EPERM' });
    expect(k).toBe(1);
    let j = 0;
    await expect(retryTransientRename(async () => {
      j += 1;
      throw busy('EACCES');
    }, async () => false, 'win32', [1, 1])).rejects.toMatchObject({ code: 'EACCES' });
    expect(j).toBe(3);
    await expect(retryTransientRename(async () => {
      throw busy('ENOENT');
    }, async () => false, 'win32', [1])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
