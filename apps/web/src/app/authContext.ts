import { createContext } from 'react';
import type { IMe } from '../api/types';

export type TAuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

export interface IAuthApi {
  status: TAuthStatus;
  me: IMe | null;
  /** Ошибка проверки сеанса (сеть, сервер), если status = 'error'. */
  error: unknown;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Глобальная возможность пользователя (удобство UI; права проверяет сервер). */
  can: (capability: string) => boolean;
}

export const AuthContext = createContext<IAuthApi | null>(null);
