// Общие проверки маршрутов этапа 09: конфликт с причиной, версия входов этапа, замечание в области пользователя,
// видимость его оснований (команда над замечанием требует читать все основания — как R08-02) и актуальность основания
// (R09-01, R09-03): под блокировкой этапа команда сама обрабатывает необработанные события барьера, затем проверяет статус.
import { findingEvidence, getFinding, processPendingStageEvents, type IAccessContext, type IFindingRow, type Queryable } from '@kontur/db';
import { HttpError } from '../http/errors.ts';
import { reviewVisibility } from '../reviewMappers.ts';
import { requireInScope } from './requirementScope.ts';

export const conflict = (message: string, reason: string, target: { tenderId: string; entityType: string; entityId: string }, extra: Record<string, unknown> = {}) =>
  new HttpError(409, 'STATE_CONFLICT', message, { current: { reason, ...extra } }, target);

export const stageVersion = async (db: Queryable, stageId: string): Promise<number> =>
  Number((await db.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1', [stageId])).rows[0]!.input_version);

export const loadFinding = async (db: Queryable, ctx: IAccessContext, id: string, cap: Parameters<typeof requireInScope>[4], lock = false): Promise<IFindingRow> =>
  requireInScope(ctx, await getFinding(db, id, lock), 'finding', id, cap);

// Команда над замечанием видимого текста: нельзя решать по тому, чего не можешь прочитать (как R08-02).
export const requireFindingVisible = async (db: Queryable, ctx: IAccessContext, f: IFindingRow): Promise<void> => {
  const vis = await reviewVisibility(db, ctx, f.stage_id, await findingEvidence(db, [f.id]));
  if (!vis.finding(f.id)) {
    throw conflict('среди оснований замечания есть то, что вы не можете читать', 'restricted_fragments', { tenderId: f.tender_id, entityType: 'finding', entityId: f.id });
  }
};

// Доменная блокировка этапа и обработка поступивших событий в транзакции команды: решение не зависит от того, успел ли
// worker выполнить инвалидацию.
export const syncStageForDecision = async (db: Queryable, stageId: string): Promise<void> => {
  await processPendingStageEvents(db, stageId);
};

// Решение, ось, разногласие — только по действующему замечанию: «устарело» — основание изменилось, сначала перепроверка.
export const requireFindingCurrent = (f: IFindingRow): void => {
  if (f.status === 'stale') {
    throw conflict('основание замечания изменилось: решение — только после перепроверки', 'finding_stale', { tenderId: f.tender_id, entityType: 'finding', entityId: f.id });
  }
};
