// Общие проверки маршрутов этапа 08: этап и реестр — в области пользователя (иначе 404), возможность —
// по роли участника (Р-08-8, первая линия; вторая — has_stage_capability в БД), изменения — только в
// активном реестре этапа (Р-08-6).
import type { TenderCapability } from '@kontur/core';
import { contentTenderIds, getRequirementRegistry, readableFragments, type IAccessContext, type IEvidenceLinkRow, type IRequirementRegistryRow, type Queryable } from '@kontur/db';
import { HttpError, notFound } from '../http/errors.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

export const loadStageWith = async (db: Queryable, ctx: IAccessContext, stageId: string, cap: TenderCapability, lock = false) => {
  const stage = await loadStage(db, ctx, stageId, lock);
  requireTenderCapById(ctx, stage.tender_id, cap, { entityType: 'tender_stage', entityId: stage.id });
  return stage;
};

export const loadRegistryWith = async (db: Queryable, ctx: IAccessContext, id: string, cap: TenderCapability): Promise<IRequirementRegistryRow> => {
  const r = await getRequirementRegistry(db, id);
  if (!r || !contentTenderIds(ctx).includes(r.tender_id)) throw notFound({ entityType: 'requirement_registry', entityId: id });
  requireTenderCapById(ctx, r.tender_id, cap, { entityType: 'requirement_registry', entityId: r.id });
  return r;
};

// Объект этапа 08 в области пользователя: тендер объекта — тендер участника; иначе — как несуществующий.
export const requireInScope = <T extends { tender_id: string }>(ctx: IAccessContext, row: T | null, entityType: string, id: string, cap: TenderCapability): T => {
  if (!row || !contentTenderIds(ctx).includes(row.tender_id)) throw notFound({ entityType, entityId: id });
  requireTenderCapById(ctx, row.tender_id, cap, { entityType, entityId: id });
  return row;
};

export const requireActiveRegistry = (active: boolean, target: { tenderId: string; entityType: string; entityId: string }): void => {
  if (!active) {
    throw new HttpError(409, 'STATE_CONFLICT', 'реестр не активен: изменения — только в активном реестре этапа, кандидат прежнего реестра — явным переносом', { current: { reason: 'registry_not_active' } }, target);
  }
};

export const readableOf = (db: Queryable, ctx: IAccessContext, groups: Iterable<readonly IEvidenceLinkRow[]>): Promise<Set<string>> =>
  readableFragments(db, ctx, [...groups].flatMap((g) => g.map((l) => l.fragment_id)));
