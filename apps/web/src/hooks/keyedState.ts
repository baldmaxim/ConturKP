// Правило принадлежности результата ключу экрана. Отдельный модуль без зависимостей:
// инвариант «результат прежнего ключа не виден ни в одном рендере» проверяется без React
// и без графа веб-приложения (R04-14, R04-15).

export interface IKeyedState<T> {
  key: string;
  data: T | null;
  error: unknown;
  loading: boolean;
}

export const pendingState = <T,>(key: string): IKeyedState<T> => ({ key, data: null, error: null, loading: true });

/**
 * Что экран вправе показать по ключу key, имея состояние state. Состояние чужого ключа
 * для текущего ключа не существует: ни данных, ни ошибки — идёт загрузка.
 */
export const viewOf = <T,>(state: IKeyedState<T>, key: string): IKeyedState<T> =>
  state.key === key ? state : pendingState<T>(key);
