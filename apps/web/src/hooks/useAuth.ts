import { useContext } from 'react';
import { AuthContext, type IAuthApi } from '../app/authContext';

export const useAuth = (): IAuthApi => {
  const api = useContext(AuthContext);
  if (!api) {
    throw new Error('useAuth вызван вне AuthProvider');
  }
  return api;
};
