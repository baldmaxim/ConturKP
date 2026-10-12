import { useState, type FC } from 'react';
import { listChatProposals } from '../../api/mcpEndpoints';
import type { IChatProposal, TChatProposalKind } from '../../api/mcpTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { CHAT_PROPOSAL_KIND, ChatProposalDecisionDialog } from './ChatProposalDecisionDialog';
import styles from './ChatProposals.module.css';

const KIND: Record<TChatProposalKind, string> = CHAT_PROPOSAL_KIND;

interface IChatProposalsTabProps {
  stageId: string;
}

/**
 * Предложения из чата (этап 16): то, что чат-клиент предложил от имени пользователя через MCP. Предложение ничего не
 * меняет, пока его не принял человек; принятая запись создаётся от имени принявшего. Предложение, среди цитат которого
 * есть источник, закрытый для читателя, показывается без текста.
 */
export const ChatProposalsTab: FC<IChatProposalsTabProps> = ({ stageId }) => {
  const res = useApiResource((signal) => listChatProposals(stageId, signal), stageId);
  const [decision, setDecision] = useState<{ proposal: IChatProposal; mode: 'accept' | 'reject' } | null>(null);

  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <LoadingState />;
  const items = res.data.items;

  return (
    <div className={styles.stack}>
      <Notice tone="info">
        Чат-клиент (Codex, Cursor) может только предложить. Замечанием, вопросом или причиной предложение становится после вашего решения — и от вашего имени.
      </Notice>
      {items.length === 0 ? (
        <EmptyState icon="message-square" title="Предложений из чата нет" text="Они появятся здесь, когда чат-клиент с правом предлагать сохранит замечание, вопрос, текст условия или причину изменения." />
      ) : (
        <ul className={styles.list}>
          {items.map((p) => (
            <li key={p.id} className={styles.item} data-status={p.status}>
              <div className={styles.head}>
                <Badge label={KIND[p.kind]} icon="message-square" tone="info" />
                {p.status === 'open' ? <Badge label="Ждёт решения" icon="circle-dot" tone="warning" dashed /> : null}
                {p.status === 'accepted' ? <Badge label="Принято" icon="shield-check" tone="success" /> : null}
                {p.status === 'rejected' ? <Badge label="Отклонено" icon="circle-x" tone="neutral" /> : null}
              </div>
              {p.restricted ? (
                <Notice tone="warning">Содержимое закрыто: среди цитат предложения есть источник, который вы не можете читать.</Notice>
              ) : (
                <>
                  {p.title ? <h3 className={styles.title}>{p.title}</h3> : null}
                  <p className={styles.body}>{p.body}</p>
                  {p.citedFragmentIds.length > 0 ? (
                    <div className={styles.citations}>
                      {p.citedFragmentIds.map((id, index) => (
                        <AppLink key={id} to={`/evidence/${id}`}>
                          Цитата {index + 1}
                        </AppLink>
                      ))}
                    </div>
                  ) : (
                    <span className={styles.meta}>Без цитат</span>
                  )}
                </>
              )}
              <span className={styles.meta}>
                Предложено через чат от имени: {p.proposedOnBehalfOf.name} · {formatDateTime(p.createdAt)}
              </span>
              {p.decidedBy ? (
                <span className={styles.meta}>
                  {p.status === 'accepted' ? 'Принял' : 'Отклонил'}: {p.decidedBy.name} · {formatDateTime(p.decidedAt)}
                  {p.decisionReason ? ` · ${p.decisionReason}` : ''}
                </span>
              ) : null}
              {p.can.decide ? (
                <div className={styles.actions}>
                  <Button variant="primary" onClick={() => setDecision({ proposal: p, mode: 'accept' })}>
                    Принять
                  </Button>
                  <Button onClick={() => setDecision({ proposal: p, mode: 'reject' })}>Отклонить</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {decision ? (
        <ChatProposalDecisionDialog
          proposal={decision.proposal}
          mode={decision.mode}
          onClose={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            res.reload();
          }}
        />
      ) : null}
    </div>
  );
};
