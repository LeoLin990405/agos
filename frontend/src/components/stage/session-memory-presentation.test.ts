import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionMemoryItem } from './session-memory-model';
import {
  compactSessionMemoryItems,
  filterSessionMemoryByQuery,
  importanceUnit,
  sessionMemoryByKind,
  sessionMemoryByTurn,
} from './session-memory-presentation';

const item = (
  id: string,
  kind: SessionMemoryItem['kind'],
  sourceTurn: number,
): SessionMemoryItem => ({
  id,
  kind,
  text: id,
  importance: 3,
  sourceTurn,
  createdAt: '2026-08-22T00:00:00.000Z',
});

test('session memory groups keep kind order and optional filter', () => {
  const items = [
    item('f', 'fact', 2),
    item('c', 'constraint', 1),
    item('r', 'rejected', 2),
  ];
  assert.deepEqual(sessionMemoryByKind(items).map((group) => group.kind), ['constraint', 'fact', 'rejected']);
  assert.deepEqual(sessionMemoryByKind(items, 'fact').map((group) => group.items.map((row) => row.id)), [['f']]);
});

test('session memory turn groups follow episode order', () => {
  const items = [item('b', 'fact', 4), item('a', 'preference', 1), item('c', 'fact', 1)];
  assert.deepEqual(sessionMemoryByTurn(items).map((group) => group.sourceTurn), [1, 4]);
  assert.equal(sessionMemoryByTurn(items, 'preference')[0]?.items[0]?.id, 'a');
  assert.equal(importanceUnit(5), 1);
  assert.equal(importanceUnit(1), 0.2);
});

test('query filter is a case-insensitive text contains and does not invent rows', () => {
  const items = [item('不要改 fold', 'fact', 1), item('用中文写记忆', 'constraint', 2)];
  items[0] = { ...items[0], text: '不要改 fold' };
  items[1] = { ...items[1], text: '用中文写记忆' };
  assert.deepEqual(filterSessionMemoryByQuery(items, '  FOLD  ').map((row) => row.id), ['不要改 fold']);
  assert.deepEqual(filterSessionMemoryByQuery(items, '图谱'), []);
});

test('compact session memory keeps the first three and reports the hidden remainder', () => {
  const items = [item('a', 'fact', 1), item('b', 'fact', 2), item('c', 'fact', 3), item('d', 'fact', 4)];
  assert.deepEqual(compactSessionMemoryItems(items).items.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(compactSessionMemoryItems(items).hidden, 1);
  assert.equal(compactSessionMemoryItems(items.slice(0, 2)).hidden, 0);
});
