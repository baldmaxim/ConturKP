import { createContext } from 'react';

export type TToastKind = 'success' | 'info' | 'error';

export interface IToastInput {
  kind: TToastKind;
  text: string;
}

export interface IToast extends IToastInput {
  id: number;
}

export interface IToastApi {
  push: (toast: IToastInput) => void;
}

export const ToastContext = createContext<IToastApi | null>(null);
