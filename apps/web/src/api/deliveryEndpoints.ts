// Вызовы этапа 14 (D-034; portal-api §2.10). Назначения — администратор; доставки — участники тендера с delivery.manage.
import { apiGet, apiPatch, apiPost } from './client';
import type { IDeliveryView, IDestinationInput, IDestinationView, IReleaseDeliveries, TDeliveryKind } from './deliveryTypes';

const enc = encodeURIComponent;

export const listReleaseDeliveries = (releaseId: string, signal?: AbortSignal) => apiGet<IReleaseDeliveries>(`/releases/${enc(releaseId)}/deliveries`, { signal });

export const placeRelease = (releaseId: string, idempotencyKey: string) =>
  apiPost<IReleaseDeliveries & { created: string[]; skipped: string[] }>(`/releases/${enc(releaseId)}/deliveries`, { body: {}, idempotencyKey });

export type TDeliveryAction = 'retry' | 'resolve-conflict' | 'redirect' | 'confirm-cloud';

export const deliveryAction = (d: IDeliveryView, action: TDeliveryAction, text: string, idempotencyKey: string) =>
  apiPost<IDeliveryView>(`/deliveries/${enc(d.id)}/${action}`, { body: action === 'confirm-cloud' ? { note: text } : { reason: text }, ifMatch: d.etag, idempotencyKey });

export const listDestinations = (signal?: AbortSignal) => apiGet<{ items: IDestinationView[] }>('/delivery-destinations', { signal });

export const createDestination = (body: IDestinationInput & { title: string; kind: TDeliveryKind; environment: 'test' | 'production' }, idempotencyKey: string) =>
  apiPost<IDestinationView>('/delivery-destinations', { body, idempotencyKey });

export const newDestinationVersion = (d: IDestinationView, body: IDestinationInput, idempotencyKey: string) =>
  apiPost<IDestinationView>(`/delivery-destinations/${enc(d.id)}/versions`, { body, ifMatch: d.etag, idempotencyKey });

export const patchDestination = (d: IDestinationView, body: { title?: string; active?: boolean }) =>
  apiPatch<IDestinationView>(`/delivery-destinations/${enc(d.id)}`, { body, ifMatch: d.etag });

export const probeDestination = (d: IDestinationView, idempotencyKey: string) =>
  apiPost<IDestinationView & { jobId: string }>(`/delivery-destinations/${enc(d.id)}/probe`, { body: {}, idempotencyKey });
