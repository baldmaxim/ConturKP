import type { FC } from 'react';
import type { ISearchRun } from '../../api/types';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { Notice } from '../../components/Notice';
import { semanticReasonLabel } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import { SearchHitCard } from './SearchHitCard';
import styles from './SearchTab.module.css';

interface ISearchRunViewProps {
  run: ISearchRun;
}

const statusBadge = (run: ISearchRun) => {
  if (run.status === 'pending') return <Badge tone="info" icon="loader-circle" dashed label="Смысловой поиск выполняется" />;
  if (run.status === 'complete') return <Badge tone="success" icon="check" label="Поиск завершён" />;
  if (run.status === 'degraded') return <Badge tone="warning" icon="info" dashed label="Без смыслового поиска" />;
  return <Badge tone="danger" icon="circle-x" label="Ответ отклонён" />;
};

/**
 * Прогон поиска: охват области, состояние смысловой ветки и итог. Пока смысловая ветка не готова,
 * показывается предварительный результат точной и полнотекстовой веток — с явной пометкой,
 * итогом он не считается (ADR-012 §14). Пустой итог — «не найдено в области», а не «не
 * предусмотрено» (I07).
 */
export const SearchRunView: FC<ISearchRunViewProps> = ({ run }) => {
  const scope = run.scope;
  const items = run.fused?.items ?? run.lexical?.items ?? [];
  return (
    <section className={styles.run} aria-label="Результат поиска" aria-busy={run.status === 'pending'}>
      <div className={styles.runHead}>
        {statusBadge(run)}
        <span className={list.muted}>
          {`Область: ${scope.units} ед. источника, распознано ${scope.pagesRecognized} из ${scope.pagesTotal} стр.`}
          {run.context.mode === 'review' ? ' · снимок области' : ' · рабочий состав'}
        </span>
      </div>
      {run.status === 'degraded' && run.semantic.reason ? (
        <Notice tone="warning">{`Смысловой поиск не участвовал: ${semanticReasonLabel(run.semantic.reason)}. Результат — точный и полнотекстовый поиск.`}</Notice>
      ) : null}
      {scope.unitsNotIndexed > 0 ? (
        <Notice tone="warning">{`Ещё не проиндексировано единиц источника: ${scope.unitsNotIndexed}. Их текст в этот поиск не вошёл.`}</Notice>
      ) : null}
      {scope.excludedByAcl > 0 ? (
        <Notice tone="info">{`Исключено по правам единиц источника: ${scope.excludedByAcl}. Их содержимое в поиск не вошло — например, документы договора без права чтения.`}</Notice>
      ) : null}
      {scope.revisionsWithoutRun > 0 ? (
        <Notice tone="info">{`Редакций без распознавания в области: ${scope.revisionsWithoutRun} — по ним доступен только оригинал.`}</Notice>
      ) : null}
      {run.status === 'failed' ? (
        <Notice tone="danger">Ответ содержал фрагмент вне области поиска и отклонён целиком. Событие записано в журнал.</Notice>
      ) : null}
      {run.lexical ? <p className={styles.preliminary}>Предварительный результат: точный и полнотекстовый поиск. Итог появится, когда завершится смысловой.</p> : null}
      {items.length > 0 ? (
        <ol className={styles.hits}>
          {items.map((hit) => (
            <SearchHitCard key={hit.fragmentId} hit={hit} />
          ))}
        </ol>
      ) : run.emptyMessage ? (
        <EmptyState icon="search" title="Ничего не найдено" text={`${run.emptyMessage}. Это не значит, что требования нет в документах вне области.`} />
      ) : null}
    </section>
  );
};
