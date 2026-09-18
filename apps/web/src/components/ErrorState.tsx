import type { FC } from 'react';
import { describeError, hasCode } from '../api/errors';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Notice } from './Notice';

interface IErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Текст для 404 и 403: объект не найден или нет доступа. */
  notFoundTitle?: string;
}

/** Ошибка загрузки: «нет доступа» отдельно от прочих сбоев (BRAND.md §9.9). */
export const ErrorState: FC<IErrorStateProps> = ({ error, onRetry, notFoundTitle = 'Не найдено или нет доступа' }) => {
  if (hasCode(error, 'NOT_FOUND') || hasCode(error, 'FORBIDDEN')) {
    return (
      <EmptyState
        icon="shield-x"
        title={notFoundTitle}
        text="Объекта нет или у вас нет прав на него. Если доступ нужен, обратитесь к администратору портала."
      />
    );
  }
  return (
    <Notice
      tone="danger"
      action={
        onRetry ? (
          <Button icon="refresh-cw" onClick={onRetry}>
            Повторить
          </Button>
        ) : undefined
      }
    >
      {describeError(error)}
    </Notice>
  );
};
