// ResolveHoldsRequest.holdIds: max(200). Регрессия проверяет каждую порцию контрактом API.
export const MAX_HOLDS_PER_RESOLUTION = 200;

/** Выбор ограничен размером одной атомарной команды API; недоступные события не переносятся в решение. */
export const selectedHolds = (chosen: readonly string[], decidable: readonly string[]): string[] => {
  const allowed = new Set(decidable);
  return [...new Set(chosen)].filter((id) => allowed.has(id)).slice(0, MAX_HOLDS_PER_RESOLUTION);
};

export const toggleHoldBatch = (selected: readonly string[], decidable: readonly string[]): string[] => {
  const batch = decidable.slice(0, MAX_HOLDS_PER_RESOLUTION);
  return batch.length === selected.length && batch.every((id) => selected.includes(id)) ? [] : batch;
};

export const toggleHold = (selected: readonly string[], id: string): string[] =>
  selected.includes(id) ? selected.filter((x) => x !== id) : selected.length < MAX_HOLDS_PER_RESOLUTION ? [...selected, id] : [...selected];
