import type { FC } from 'react';
import { Badge } from './Badge';

interface IStatusBadgeProps {
  status: 'active' | 'archived';
  outcome?: 'won' | 'lost' | null;
}

export const StatusBadge: FC<IStatusBadgeProps> = ({ status, outcome }) =>
  status === 'active' ? (
    <Badge tone="neutral" icon="circle-dot" label="Действующий" />
  ) : (
    <Badge
      tone={outcome === 'won' ? 'success' : outcome === 'lost' ? 'danger' : 'muted'}
      icon="archive"
      label={outcome === 'won' ? 'В архиве · Выиграно' : outcome === 'lost' ? 'В архиве · Проиграно' : 'В архиве'}
      title={outcome === 'won' ? 'В архиве · Выиграно' : outcome === 'lost' ? 'В архиве · Проиграно' : 'В архиве'}
    />
  );
