// Идентификатор установленной сборки (этап 17): коммит, по которому собрана установка. На установке из ZIP каталога
// .git нет — коммит задаётся в файле окружения (KONTUR_BUILD, его пишет runbook из комментария архива); в рабочей
// копии Git он читается из .git без вызова git. Нужен манифесту копии, экрану состояния и записи живых проверок.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/u;

export const buildId = (env: Record<string, string | undefined> = process.env, root: string = process.cwd()): string | null => {
  const configured = env.KONTUR_BUILD?.trim();
  if (configured) return configured;
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;
    const ref = /^ref: (.+)$/u.exec(head)?.[1];
    if (!ref) return null;
    try {
      const sha = readFileSync(join(root, '.git', ...ref.split('/')), 'utf8').trim();
      return SHA.test(sha) ? sha : null;
    } catch {
      const line = readFileSync(join(root, '.git', 'packed-refs'), 'utf8')
        .split(/\r?\n/u)
        .find((l) => l.endsWith(` ${ref}`));
      const sha = line?.split(' ')[0] ?? '';
      return SHA.test(sha) ? sha : null;
    }
  } catch {
    return null;
  }
};
