import { useContext } from 'react';
import { ToastContext, type IToastApi } from '../app/toastContext';

export const useToast = (): IToastApi => {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToast вызван вне ToastProvider');
  }
  return api;
};
