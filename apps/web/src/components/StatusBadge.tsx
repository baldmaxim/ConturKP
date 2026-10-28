import type { FC } from 'react';
import { Badge } from './Badge';
import { TENDER_OUTCOME_LABELS } from '../utils/labels';

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
      label={outcome ? `В архиве · ${TENDER_OUTCOME_LABELS[outcome]}` : 'В архиве'}
      title={outcome ? `В архиве · ${TENDER_OUTCOME_LABELS[outcome]}` : 'В архиве'}
    />
  );
