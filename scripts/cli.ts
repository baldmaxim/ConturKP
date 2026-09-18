// Общее для консольных команд: аргументы и ввод пароля без эха и без записи в историю.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const readAllStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
};

const promptHidden = (question: string): Promise<string> =>
  new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write: (chunk, _enc, cb) => {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });

// --password-stdin: пароль одной строкой из stdin (для сценариев); иначе — скрытый ввод дважды.
export const readPassword = async (label: string): Promise<string> => {
  if (hasFlag('password-stdin')) return readAllStdin();
  if (!process.stdin.isTTY) throw new Error('нет терминала: используйте --password-stdin');
  const first = await promptHidden(`${label}: `);
  const second = await promptHidden('Повторите пароль: ');
  if (first !== second) throw new Error('пароли не совпадают');
  return first;
};

export const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};
