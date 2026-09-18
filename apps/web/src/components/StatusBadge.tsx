import type { FC } from 'react';
import { Badge } from './Badge';

interface IStatusBadgeProps {
  status: 'active' | 'archived';
}

/** Статус тендера или этапа: «Действующий» / «В архиве». */
export const StatusBadge: FC<IStatusBadgeProps> = ({ status }) =>
  status === 'active' ? (
    <Badge tone="neutral" icon="circle-dot" label="Действующий" />
  ) : (
    <Badge tone="muted" icon="archive" label="В архиве" />
  );
