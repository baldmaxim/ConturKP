import type { FC } from 'react';
import type { TTenderOutcome, TTenderStatus } from '../api/types';
import { Badge } from './Badge';
import { StatusBadge } from './StatusBadge';

export const TenderStatusBadge: FC<{ status: TTenderStatus; outcome: TTenderOutcome | null }> = ({ status, outcome }) =>
  status === 'archived' && outcome ? (
    <Badge tone={outcome === 'won' ? 'success' : 'muted'} icon="archive" label={outcome === 'won' ? 'В архиве · Выигран' : 'В архиве · Проигран'} />
  ) : (
    <StatusBadge status={status} />
  );
