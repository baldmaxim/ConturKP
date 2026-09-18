// Модульные тесты доменных правил без БД: возможности, ETag, пароли.
import { describe, expect, it } from 'vitest';
import {
  canSeeTenderCard,
  formatEtag,
  globalCapabilities,
  hashPassword,
  parseIfMatch,
  passwordProblem,
  tenderCapabilities,
  verifyPassword,
  type Role,
} from '../packages/core/src/index.ts';

const roles = (...r: Role[]) => new Set<Role>(r);

describe('возможности', () => {
  it('инженер-участник: чтение и правка этапа, без управления и журнала', () => {
    expect(tenderCapabilities(roles('engineer'), 'engineer')).toEqual(['tender.read', 'stage.write']);
  });
  it('руководитель-участник: управление этапами и журнал', () => {
    expect(tenderCapabilities(roles('manager'), 'manager')).toEqual(['tender.read', 'stage.write', 'stage.manage', 'audit.read']);
  });
  it('назначение без соответствующей глобальной роли не действует', () => {
    expect(tenderCapabilities(roles('engineer'), 'manager')).toEqual([]);
    expect(canSeeTenderCard(roles('engineer'), 'manager')).toBe(false);
  });
  it('администратор без назначения: только администрирование и журнал, без содержимого', () => {
    expect(tenderCapabilities(roles('admin'), null)).toEqual(['audit.read', 'admin.tender']);
    expect(canSeeTenderCard(roles('admin'), null)).toBe(true);
    expect(globalCapabilities(roles('admin'))).toEqual(['admin.users', 'admin.tender', 'admin.audit']);
    expect(globalCapabilities(roles('manager', 'engineer'))).toEqual([]);
  });
});

describe('ETag', () => {
  const id = '4b0e7d2a-1c1f-4a55-9d3e-0a1b2c3d4e5f';
  it('формат и разбор', () => {
    expect(parseIfMatch(formatEtag(id, 7))).toEqual({ kind: 'ok', id, rowVersion: 7 });
    expect(parseIfMatch(undefined)).toEqual({ kind: 'missing' });
    expect(parseIfMatch('*')).toEqual({ kind: 'invalid' });
    expect(parseIfMatch(`"${id}:x"`)).toEqual({ kind: 'invalid' });
  });
});

describe('пароли argon2id', () => {
  it('хэш в формате PHC, проверка верного и неверного пароля', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('correct-horse-battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
  it('минимальная длина', () => {
    expect(passwordProblem('short')).not.toBeNull();
    expect(passwordProblem('long-enough-pass')).toBeNull();
  });
});
