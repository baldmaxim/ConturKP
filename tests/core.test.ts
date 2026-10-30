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
  it('инженер-участник: чтение и правка этапа, предложения требований и фактов, без управления и журнала', () => {
    expect(tenderCapabilities(roles('engineer'), 'engineer')).toEqual([
      'tender.read',
      'stage.write',
      'source.write',
      'calculation.capture',
      'requirement.read',
      'requirement.create',
      'analysis.run',
      'fact.read',
      'fact.create',
      'review.run',
      'finding.write',
      'economics.compare',
      'change_reason.confirm',
      'application.fill',
      'candidate.create',
      // Этап 14 (D-034 В-14-5): размещение — инженер и руководитель тендера.
      'delivery.manage',
      'mcp.propose',
      // Этап 13 (D-033 В-13-7): выпуск — инженер тендера.
      'candidate.release',
      // Этап 15 (state-machines §17, ADR-006 п. 3): отправку и нарушение регистрирует инженер тендера.
      'send.register',
    ]);
  });
  it('руководитель-участник: управление этапами и журнал', () => {
    expect(tenderCapabilities(roles('manager'), 'manager')).toEqual([
      'tender.read',
      'stage.write',
      'source.write',
      'calculation.capture',
      'requirement.read',
      'requirement.create',
      'analysis.run',
      'fact.read',
      'fact.create',
      'review.run',
      'finding.write',
      'economics.compare',
      'change_reason.confirm',
      'application.fill',
      'candidate.create',
      'delivery.manage',
      'mcp.propose',
      'stage.manage',
      'hold.resolve',
      'requirement.confirm',
      'requirement.decide',
      'requirement.manage',
      'fact.confirm',
      'finding.accept_risk',
      'source_priority.manage',
      'template.manage',
      // Этап 13 (ADR-006 §3): согласование и принятие риска — руководитель тендера.
      'candidate.approve',
      'risk.accept',
      // Этап 15 (D-035 В-15-1): лишние вложения письма об отправке принимает руководитель тендера.
      'send.accept_extras',
      // Этап 18 (D-044, Q-01): решение о закрытом расчёте — руководитель тендера.
      'calculation.close',
      'audit.read',
    ]);
  });
  it('назначение без соответствующей глобальной роли не действует', () => {
    expect(tenderCapabilities(roles('engineer'), 'manager')).toEqual([]);
    expect(canSeeTenderCard(roles('engineer'), 'manager')).toBe(false);
  });
  it('администратор без назначения: только администрирование и журнал, без содержимого', () => {
    expect(tenderCapabilities(roles('admin'), null)).toEqual(['audit.read', 'admin.tender']);
    expect(canSeeTenderCard(roles('admin'), null)).toBe(true);
    expect(globalCapabilities(roles('admin'))).toEqual(['admin.users', 'admin.tender', 'admin.audit', 'admin.intake', 'admin.contract', 'admin.mailbox', 'admin.delivery']);
    // Этап 11 (D-031 В-11-3): шаблоны компании и формулировки — роль «руководитель», без доступа к содержимому тендеров.
    expect(globalCapabilities(roles('manager', 'engineer'))).toEqual(['admin.templates', 'wording.approve']);
    expect(globalCapabilities(roles('engineer'))).toEqual([]);
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
