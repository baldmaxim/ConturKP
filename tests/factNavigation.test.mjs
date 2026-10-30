import { describe, expect, it } from 'vitest';
import { factReturnPath } from '../apps/web/src/utils/factNavigation.ts';

const path = '/contracts/8f143ea7-5207-4425-9995-3eba81adb8f4?tab=facts&file=doc&fact=value&retired=1';
describe('return from a fact citation', () => {
  it('retains the tab, selected file, expanded fact and historical view', () => {
    expect(factReturnPath(path)).toBe(path);
    expect(factReturnPath(path.replace('/contracts/', '/tenders/'))).toBe(path.replace('/contracts/', '/tenders/'));
  });
  it('rejects external, unrelated, incomplete or malformed destinations', () => {
    for (const value of [null, '', 'https://example.com' + path, '//' + 'example.com' + path, '/api/v1/contracts', path.replace('tab=facts', 'tab=card'), path.replace('contracts/', 'documents/'), '/contracts/no-id?tab=facts', '/\\example.com', path + '\n']) expect(factReturnPath(value)).toBeNull();
  });
});
