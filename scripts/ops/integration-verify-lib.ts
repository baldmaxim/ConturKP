// Запись живой проверки в базу установки (этап 17, проект §11, state-machines §19): VERIFIED_LIVE ставит администратор
// после разрешённой живой проверки, и только со ссылкой на её журнал. Журнал принимается, если в нём режим LIVE,
// коммит именно установленной сборки и «Итог: PASS»; ссылка — имя журнала и его SHA-256. Событие — в журнал аудита
// от имени действующего администратора. Фикстурный прогон в VERIFIED_LIVE не превращается.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { recordLiveVerification, withTransaction, writeAudit, type Pool } from '../../packages/db/src/index.ts';

export interface IVerifyInput {
  system: string;
  component: string;
  journal: string;
  adminLogin: string;
  build: string | null;
  create: boolean;
}

export class VerifyError extends Error {}

// Требования к журналу; пустой список — журнал годится.
export const journalProblems = (text: string, build: string | null): string[] => {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/u);
  if (!lines.some((l) => l.trim() === 'Итог: PASS')) problems.push('в журнале нет строки «Итог: PASS»');
  if (/Режим:\s*FIXTURE/u.test(text)) problems.push('журнал фикстурного прогона — это не живая проверка');
  if (!/Режим:\s*LIVE/u.test(text)) problems.push('в журнале нет отметки «Режим: LIVE»');
  if (!build) problems.push('коммит установленной сборки неизвестен: задайте KONTUR_BUILD');
  else {
    const m = /Сборка:\s*([0-9a-f]{7,40}|не задана)/u.exec(text);
    if (!m) problems.push('в журнале нет коммита сборки («Сборка: …»)');
    else if (m[1] === 'не задана' || !build.startsWith(m[1]!)) problems.push(`журнал снят на сборке ${m[1]}, установлена ${build}`);
  }
  return problems;
};

export const recordLiveCheck = async (pool: Pool, i: IVerifyInput): Promise<{ evidenceRef: string }> => {
  const text = readFileSync(i.journal, 'utf8');
  const problems = journalProblems(text, i.build);
  if (problems.length > 0) throw new VerifyError(problems.join('; '));
  const sha = createHash('sha256').update(readFileSync(i.journal)).digest('hex');
  const evidenceRef = `${basename(i.journal)} sha256:${sha}`;
  const verifiedAt = statSync(i.journal).mtime;
  await withTransaction(pool, async (client) => {
    const admin = await client.query<{ id: string }>(
      `SELECT u.id FROM app_user u WHERE u.login = $1 AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role = 'admin')`,
      [i.adminLogin],
    );
    const adminId = admin.rows[0]?.id;
    if (!adminId) throw new VerifyError(`«${i.adminLogin}» — не действующий администратор`);
    const row = await client.query('SELECT 1 FROM integration_status WHERE system = $1 AND component = $2', [i.system, i.component]);
    if ((row.rowCount ?? 0) === 0 && !i.create) {
      const known = (await client.query<{ k: string }>("SELECT system || '/' || component AS k FROM integration_status ORDER BY 1")).rows.map((r) => r.k);
      throw new VerifyError(`строки ${i.system}/${i.component} нет (есть: ${known.join(', ')}); новую — с --create`);
    }
    await recordLiveVerification(client, { system: i.system, component: i.component, evidenceRef, verifiedAt, details: { live: 'VERIFIED_LIVE', build: i.build } });
    await writeAudit(client, {
      actorUserId: adminId,
      principalKind: 'human',
      action: 'integration.verify_live',
      entityType: 'integration_status',
      entityId: null,
      outcome: 'allowed',
      details: { system: i.system, component: i.component, evidenceRef, build: i.build },
    });
  });
  return { evidenceRef };
};
