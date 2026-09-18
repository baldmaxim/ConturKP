// Проверка возможности по тендеру для объектов, найденных в области пользователя.
import { tenderCapabilities, type TenderCapability } from '@kontur/core';
import { memberRoleOf, type IAccessContext } from '@kontur/db';
import { forbidden, type IAuditTarget } from '../http/errors.ts';

export const hasTenderCap = (ctx: IAccessContext, tenderId: string, cap: TenderCapability): boolean =>
  tenderCapabilities(ctx.roles, memberRoleOf(ctx, tenderId)).includes(cap);

export const requireTenderCapById = (ctx: IAccessContext, tenderId: string, cap: TenderCapability, target: IAuditTarget): void => {
  if (!hasTenderCap(ctx, tenderId, cap)) throw forbidden(cap, { ...target, tenderId });
};
