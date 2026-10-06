import type { FC } from 'react';
import { PageHeader } from '../../components/PageHeader';
import form from '../../styles/form.module.css';
import { TemplatesPanel } from './TemplatesPanel';
import { WordingsPanel } from './WordingsPanel';

/** «Шаблоны и формулировки» (этап 11, D-031 В-11-2, В-11-3): права на общую библиотеку доступа к тендерам не дают. */
export const FormsLibraryPage: FC = () => (
  <div className={form.stack}>
    <PageHeader title="Шаблоны и формулировки" />
    <TemplatesPanel />
    <WordingsPanel />
  </div>
);
