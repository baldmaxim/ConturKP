import { createContext } from 'react';
import type { IOfficeModel, IOfficeView } from './officeModel';
import type { TOfficeStatus } from './officeStatus';

export interface IOfficeResource {
  data: IOfficeView | null;
  office: IOfficeModel | null;
  error: unknown;
  loading: boolean;
  stale: boolean;
  status: TOfficeStatus;
  reload: () => void;
}

export const EMPTY_OFFICE: IOfficeResource = { data: null, office: null, error: null, loading: true, stale: false, status: 'loading', reload: () => undefined };
export const OfficeContext = createContext<IOfficeResource>(EMPTY_OFFICE);
