import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelative } from './time';

const NOW = 2_000_000_000;

test('formatRelative rejects invalid timestamps', () => {
  assert.equal(formatRelative(0, NOW), '');
  assert.equal(formatRelative(-1, NOW), '');
  assert.equal(formatRelative(Number.NaN, NOW), '');
  assert.equal(formatRelative(Number.POSITIVE_INFINITY, NOW), '');
});

test('formatRelative handles exact unit boundaries', () => {
  assert.equal(formatRelative(NOW - 59_999, NOW), '刚刚');
  assert.equal(formatRelative(NOW - 60_000, NOW), '1 分钟前');
  assert.equal(formatRelative(NOW - 3_600_000, NOW), '1 小时前');
  assert.equal(formatRelative(NOW - 86_400_000, NOW), '1 天前');
});

test('formatRelative treats future timestamps as just now', () => {
  assert.equal(formatRelative(NOW + 60_000, NOW), '刚刚');
});
