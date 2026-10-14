// Жизненный цикл процессов server и worker под службой Windows (этап 17, проект §3.4).
// Обёртка службы (WinSW) останавливает процесс через Ctrl+C — Node получает его как SIGINT; затем по истечении
// stoptimeout завершает процесс принудительно. Процессные тесты на Windows шлют IPC { type: 'shutdown' }:
// child.kill() там всегда TerminateProcess. Повторный сигнал — немедленный выход.
// Коды выхода: 0 — штатно; 1 — фатальная ошибка; 2 — конфигурация; 3 — схема БД (их ставят сами процессы);
// 4 — принудительный выход: остановка не уложилась в срок. Штатный путь не вызывает process.exit():
// на Windows и в pipe это обрезает вывод — код ставится через exitCode, процесс завершается сам.

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_FORCED = 4;

export interface ILifecycleProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exitCode?: number | string | null | undefined;
  disconnect?: () => void;
  connected?: boolean;
}

export interface IShutdownOptions {
  name: string;
  graceMs: number;
  log: (line: string) => void;
  // Остановка самого процесса: закрыть приём работы, дождаться текущей, освободить ресурсы.
  // Возвращает true, если всё завершилось штатно; false — остались незавершённые операции.
  // fatal — остановка из-за необработанной ошибки: её причиной может быть само задание.
  stop: (reason: string, fatal: boolean) => Promise<boolean>;
  proc?: ILifecycleProcess;
  exit?: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

export interface IShutdownHandle {
  // Запуск остановки программно (тесты, фатальная ошибка). Повторный вызов возвращает ту же остановку.
  shutdown: (reason: string, code?: number) => Promise<void>;
  readonly stopping: boolean;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : 'неизвестная ошибка');

export const installShutdown = (o: IShutdownOptions): IShutdownHandle => {
  const proc = o.proc ?? (process as unknown as ILifecycleProcess);
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let running: Promise<void> | null = null;

  const shutdown = (reason: string, code = EXIT_OK): Promise<void> => {
    if (running) return running;
    o.log(`остановка: ${reason}`);
    // Срок истёк — принудительный выход с кодом 4: обёртка службы и оператор отличат его от штатного.
    const timer = setTimer(() => {
      o.log(`остановка не уложилась в ${Math.round(o.graceMs / 1000)} с — принудительный выход`);
      exit(EXIT_FORCED);
    }, o.graceMs);
    timer.unref?.();
    running = o
      .stop(reason, code !== EXIT_OK)
      .then(
        (clean) => {
          const final = code !== EXIT_OK ? code : clean ? EXIT_OK : EXIT_FORCED;
          o.log(`${o.name} остановлен${final === EXIT_OK ? '' : ` с кодом ${final}`}`);
          proc.exitCode = final;
        },
        (err: unknown) => {
          o.log(`ошибка остановки: ${describe(err)}`);
          proc.exitCode = EXIT_FATAL;
        },
      )
      .finally(() => {
        // Канал IPC держит цикл событий открытым — отпускаем, чтобы процесс завершился сам.
        if (proc.connected && proc.disconnect) proc.disconnect();
      });
    return running;
  };

  for (const signal of SIGNALS) {
    proc.on(signal, () => {
      if (running) {
        o.log(`повторный ${signal} — немедленный выход`);
        exit(EXIT_FORCED);
        return;
      }
      void shutdown(`сигнал ${signal}`);
    });
  }
  proc.on('message', (msg: unknown) => {
    if ((msg as { type?: unknown } | null)?.type === 'shutdown') void shutdown('команда остановки по IPC');
  });
  proc.on('uncaughtException', (err: unknown) => {
    o.log(`необработанная ошибка: ${describe(err)}`);
    void shutdown('необработанная ошибка', EXIT_FATAL);
  });
  proc.on('unhandledRejection', (err: unknown) => {
    o.log(`необработанный отказ обещания: ${describe(err)}`);
    void shutdown('необработанный отказ обещания', EXIT_FATAL);
  });

  return {
    shutdown,
    get stopping() {
      return running !== null;
    },
  };
};
