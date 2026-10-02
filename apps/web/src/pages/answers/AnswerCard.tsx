import type { FC } from 'react';
import type { IAnswerCitation, IAnswerPlace, IAnswerRun } from '../../api/answerTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Notice } from '../../components/Notice';
import { answerRunBadge, dropIssueLabel, VERSION_NOTE_LABELS } from '../../utils/answerLabels';
import { originMeta } from '../../utils/localRecognitionLabels';
import styles from './Answers.module.css';

interface IAnswerCardProps {
  run: IAnswerRun;
}

const placeLabel = (p: IAnswerPlace | null): string => {
  if (!p) return 'Фрагмент';
  const page = p.pageIndex === null ? null : `стр. ${p.pageLabel ?? p.pageIndex + 1}`;
  const head = p.mailSubject ? `Письмо «${p.mailSubject}»` : p.sessionTitle ? `Переговоры «${p.sessionTitle}»` : (p.documentTitle ?? 'Документ');
  return [head, page, p.sheetLabel ? `лист ${p.sheetLabel}` : null].filter(Boolean).join(' · ');
};

const CitationItem: FC<{ c: IAnswerCitation }> = ({ c }) => {
  // Происхождение без подписи портала (например, ответ на вопрос заказчика) бейджа не получает.
  const origin = c.origin ? (originMeta(c.origin, null) ?? null) : null;
  return (
    <li className={styles.citation}>
      <div className={styles.citationHead}>
        {c.number !== null ? <span className={styles.number}>{`[${c.number}]`}</span> : null}
        <span className={styles.place}>{c.restricted ? 'Основание недоступно' : placeLabel(c.place)}</span>
      </div>
      {c.restricted ? (
        <p className={styles.muted}>
          <Badge tone="muted" icon="lock" label="Нет права на источник" /> Текст не показывается.
        </p>
      ) : (
        <>
          <p className={styles.quote}>{c.text}</p>
          <div className={styles.citationFoot}>
            {c.versionNote !== 'current' ? <Badge tone="warning" icon="clock-alert" dashed label={VERSION_NOTE_LABELS[c.versionNote]} /> : null}
            {origin ? <Badge tone={origin.tone} icon={origin.icon} dashed={origin.dashed} label={origin.label} /> : null}
            <AppLink className={styles.open} to={`/evidence/${c.fragmentId}`}>
              Открыть цитату
            </AppLink>
          </div>
        </>
      )}
    </li>
  );
};

/**
 * Ответ на вопрос (D-027): показывается только прошедший правила текст — цитаты из пакета, числа с той же единицей,
 * без значений перекрытой редакции. Черновик модели не показывается и не стримится: до завершения — только состояние.
 * Статус — словарь ответа, а не результат регламентной проверки этапа 09.
 */
export const AnswerCard: FC<IAnswerCardProps> = ({ run }) => {
  const answer = run.answer;
  const issues = answer ? Object.entries(answer.droppedIssues) : [];
  const excluded = run.coverage?.excludedByAccess ?? 0;
  const incomplete = run.answerStatus === 'incomplete_processing';
  return (
    <section className={styles.answer} aria-label="Ответ" aria-busy={run.status === 'queued' || run.status === 'running'}>
      <div className={styles.answerHead}>
        {answerRunBadge(run)}
        {run.plan.followUp ? <span className={styles.muted}>С учётом предыдущего вопроса</span> : null}
      </div>
      {run.status === 'queued' || run.status === 'running' ? (
        <p className={styles.muted}>Ответ появится после проверки цитат и чисел. Черновик модели не показывается.</p>
      ) : null}
      {run.status === 'failed' ? (
        <Notice tone="warning">Ответ не получен: задание завершилось ошибкой. Это неполнота обработки, а не ответ по документам.</Notice>
      ) : null}
      {answer && !answer.visible ? (
        <Notice tone="info" icon="lock">
          Ответ опирается на основание, к которому у вас сейчас нет доступа, — текст и цитаты скрыты.
        </Notice>
      ) : null}
      {answer?.visible && answer.text ? <p className={styles.answerText}>{answer.text}</p> : null}
      {run.answerStatus === 'citations_disagree' ? (
        <Notice tone="warning">Значения в основаниях расходятся. Портал не выбирает действующее — сравните цитаты по оригиналу.</Notice>
      ) : null}
      {answer && answer.citations.length > 0 ? (
        <ol className={styles.citations} aria-label="Цитаты ответа">
          {answer.citations.map((c) => (
            <CitationItem key={c.label} c={c} />
          ))}
        </ol>
      ) : null}
      {answer && answer.droppedClaims > 0 ? (
        <p className={styles.muted}>
          {`Отклонено утверждений черновика: ${answer.droppedClaims} — ${issues.map(([code, n]) => `${dropIssueLabel(code)} (${n})`).join(', ')}. Их текст не сохраняется.`}
        </p>
      ) : null}
      {excluded > 0 ? <p className={styles.muted}>{`Исключено по правам найденных фрагментов: ${excluded}.`}</p> : null}
      {answer?.visible && answer.foundFragments.length > 0 ? (
        <details className={styles.found} open={incomplete}>
          <summary className={styles.summary}>{`Найденные фрагменты без цитаты в ответе: ${answer.foundFragments.length}`}</summary>
          <ul className={styles.citations}>
            {answer.foundFragments.map((c) => (
              <CitationItem key={c.label} c={c} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
};
