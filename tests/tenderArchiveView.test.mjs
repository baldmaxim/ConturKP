import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TendersPage } from '../apps/web/src/pages/TendersPage.tsx';
const state = vi.hoisted(() => ({
  canEdit: true,
  items: [
    { id: 'current', code: '342', title: 'Текущий тендер', status: 'active', outcome: null },
    { id: 'winner', code: '204', title: 'ЖК WAVE 2 очередь', status: 'archived', outcome: 'won' },
    { id: 'loser', code: '98', title: 'Проигранный тендер', status: 'archived', outcome: 'lost' },
  ],
}));
vi.mock('../apps/web/src/hooks/useAuth', () => ({ useAuth: () => ({ can: () => state.canEdit }) }));
vi.mock('../apps/web/src/hooks/useToast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../apps/web/src/hooks/useAppNavigate', () => ({ useAppNavigate: () => vi.fn() }));
vi.mock('../apps/web/src/hooks/useApiResource', () => ({ useApiResource: () => ({ data: { items: state.items.map(t => ({ ...t, customerName: null, objectName: null, myRole: null, capabilities: state.canEdit ? ['admin.tender'] : ['tender.read'], rowVersion: 1, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' })) }, loading: false, error: null, reload: vi.fn() }) }));
const view = (url) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(TendersPage)));
describe('списки тендеров', () => {
  it('по умолчанию показывает только действующие, в таблице и мобильных карточках', () => {
    const html = view('/');
    expect(html).toContain('Текущий тендер');
    expect(html).not.toContain('ЖК WAVE 2 очередь');
    expect(html).not.toContain('Проигранный тендер');
    expect(html).toContain('Действующие · 1');
    expect(html).toContain('Архивные · 2');
    expect(html).toContain('В архив');
    expect(html).toContain('aria-selected="true"');
  });
  it('архив показывает выигранные и проигранные со своими результатами и возвратом', () => {
    const html = view('/?status=archived');
    const visibleText = html.replace(/<[^>]*>/g, ' ');
    expect(visibleText).toContain('Выиграно');
    expect(visibleText).toContain('Проиграно');
    expect(html).not.toContain('Текущий тендер');
    expect(html).toContain('ЖК WAVE 2 очередь');
    expect(html).toContain('Проигранный тендер');
    expect(html).toContain('Выиграно');
    expect(html).toContain('Проиграно');
    expect(html).toContain('Вернуть');
    expect(html).toContain('id="tabpanel-archived"');
  });
  it('читатель переключает списки без кнопок изменения', () => {
    state.canEdit = false;
    try { const html = view('/?status=archived'); expect(html).toContain('ЖК WAVE 2 очередь'); expect(html).not.toContain('>Вернуть<'); expect(html).not.toContain('Действия'); }
    finally { state.canEdit = true; }
  });
});
