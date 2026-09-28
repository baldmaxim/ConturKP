// Ревизия расчёта TenderHub по ID, состояние закрытия и лента изменений — «проект» контракта
// (docs/contracts/adapters.md §2, X-01). У TenderHub этих маршрутов нет: реализации в портале нет,
// статус компонента — BLOCKED_EXTERNAL. Интерфейс закреплён, чтобы доменная модель (verified-ревизия,
// события статуса у источника) проверялась контрактными тестами на фикстурах без имитации в продукте.

export interface ICalculationChangeEvent {
  externalTenderId: string;
  revisionRef: string;
  status: 'closed' | 'reopened' | 'superseded';
  observedAt: string;
}

export interface ITenderHubClosureState {
  closed: boolean;
  closedAt: string | null;
  revisionRef: string | null;
}

export interface ITenderHubRevisionReader {
  getCalculationRevision(externalTenderId: string, revisionRef: string, signal?: AbortSignal): Promise<{ revisionRef: string; rawSha256: string }>;
  getClosureState(externalTenderId: string, signal?: AbortSignal): Promise<ITenderHubClosureState>;
  listChanges(cursor: string | null, signal?: AbortSignal): Promise<{ events: ICalculationChangeEvent[]; nextCursor: string | null }>;
}
