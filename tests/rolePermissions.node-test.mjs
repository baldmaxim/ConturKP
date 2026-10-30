import assert from 'node:assert/strict';
import test from 'node:test';
import { groupRolePermissions, toggleRolePermission } from '../apps/web/src/utils/rolePermissions.ts';

const catalog = [
  { code: 'stage.write', label: 'Изменение этапа', group: 'Тендеры' },
  { code: 'stage.manage', label: 'Создание этапов', group: 'Тендеры' },
  { code: 'source.write', label: 'Источники и переписка', group: 'Тендеры' },
  { code: 'mail.read', label: 'Просмотр писем', group: 'Почта' },
];

test('поиск оставляет полные счётчики группы и не меняет выбранные права', () => {
  const selected = ['stage.write', 'source.write', 'mail.read'];
  const groups = groupRolePermissions(catalog, selected, '  ИЗМЕНЕНИЕ  ');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Тендеры');
  assert.equal(groups[0].selected, 2);
  assert.equal(groups[0].total, 3);
  assert.deepEqual(groups[0].permissions.map((permission) => permission.code), ['stage.write']);
  assert.deepEqual(selected, ['stage.write', 'source.write', 'mail.read']);
});

test('поиск по названию группы показывает все её разрешения', () => {
  const groups = groupRolePermissions(catalog, [], 'тендеры');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].permissions.length, 3);
});

test('снятие найденного права сохраняет выбор вне поиска и в других группах', () => {
  const selected = ['stage.write', 'source.write', 'mail.read', 'legacy.permission'];
  const updated = toggleRolePermission(selected, 'stage.write', false);
  assert.deepEqual(updated, ['source.write', 'mail.read', 'legacy.permission']);
  assert.deepEqual(selected, ['stage.write', 'source.write', 'mail.read', 'legacy.permission']);
  const restored = groupRolePermissions(catalog, updated, '');
  assert.equal(restored[0].selected, 1);
  assert.equal(restored[1].selected, 1);
});

test('повторное включение права не создаёт дубликатов', () => {
  const selected = ['mail.read'];
  const updated = toggleRolePermission(toggleRolePermission(selected, 'stage.write', true), 'stage.write', true);
  assert.deepEqual(updated, ['mail.read', 'stage.write']);
  assert.deepEqual(selected, ['mail.read']);
});

test('пустые результаты поиска и пустой каталог обрабатываются без группы', () => {
  assert.deepEqual(groupRolePermissions(catalog, ['mail.read'], 'неизвестное действие'), []);
  assert.deepEqual(groupRolePermissions([], [], ''), []);
});
