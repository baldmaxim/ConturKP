import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResolveHoldsRequest } from '@kontur/contracts';
import { selectedHolds, toggleHold, toggleHoldBatch } from '../apps/web/src/pages/release/holdSelection.ts';

describe('выбор событий для атомарного решения', () => {
  it('даёт записать 482 события тремя допустимыми командами без пропусков и повторов', () => {
    let remaining = Array.from({ length: 482 }, () => randomUUID());
    const decided: string[] = [];
    const sizes: number[] = [];
    while (remaining.length) {
      const chosen = toggleHoldBatch([], remaining);
      const body = ResolveHoldsRequest.parse({ holdIds: chosen, resolution: 'not_applicable', reason: 'Только контрольный тестовый выпуск' });
      sizes.push(body.holdIds.length);
      decided.push(...body.holdIds);
      remaining = remaining.filter((id) => !chosen.includes(id));
    }
    expect(sizes).toEqual([200, 200, 82]);
    expect(new Set(decided).size).toBe(482);
  });

  it('не расширяет выбор вручную сверх лимита и позволяет снять отметку', () => {
    const ids = Array.from({ length: 201 }, () => randomUUID());
    const chosen = toggleHoldBatch([], ids);
    expect(toggleHold(chosen, ids[200]!)).toEqual(chosen);
    expect(toggleHold(chosen, ids[0]!)).toHaveLength(199);
    expect(toggleHoldBatch(chosen, ids)).toEqual([]);
    expect(ResolveHoldsRequest.safeParse({ holdIds: ids, resolution: 'not_applicable', reason: 'Контрольная причина' }).success).toBe(false);
  });

  it('убирает события, ставшие закрытыми или уже решёнными, до отправки', () => {
    expect(selectedHolds(['closed', 'done', 'open', 'open'], ['open', 'other'])).toEqual(['open']);
    expect(toggleHoldBatch([], ['open', 'other'])).toEqual(['open', 'other']);
  });
});
