import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WAITING = '实时谱系尚未采集';
const UNAVAILABLE = '实时谱系不可用';
const EMPTY = '谱系待机';
const HISTORY_LOADING = '正在读取谱系历史';
const HISTORY_ERROR = '谱系历史读取失败';
const HISTORY_EMPTY = '当日没有谱系记录';

test('LineageView live keeps waiting / unavailable / empty as three titles', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'LineageView.tsx'), 'utf8');

  assert.notEqual(WAITING, UNAVAILABLE);
  assert.notEqual(UNAVAILABLE, EMPTY);
  assert.notEqual(WAITING, EMPTY);

  assert.match(src, /telemetry\.at === 0/);
  assert.match(src, /telemetry\.at > 0 && telemetry\.progress === undefined/);
  assert.match(src, /realBatches\.length === 0/);
  assert.match(src, new RegExp(`title="${WAITING}"`));
  assert.match(src, new RegExp(`title="${UNAVAILABLE}"`));
  assert.match(src, new RegExp(`title="${EMPTY}"`));

  const waitingBlock = src.slice(src.indexOf('telemetry.at === 0'), src.indexOf('telemetry.at > 0'));
  const unavailableBlock = src.slice(
    src.indexOf('telemetry.at > 0 && telemetry.progress === undefined'),
    src.indexOf('telemetry.progress !== undefined'),
  );
  const emptyBlock = src.slice(src.indexOf('realBatches.length === 0'));
  assert.match(waitingBlock, new RegExp(WAITING));
  assert.doesNotMatch(waitingBlock, new RegExp(UNAVAILABLE));
  assert.doesNotMatch(waitingBlock, new RegExp(EMPTY));
  assert.match(unavailableBlock, new RegExp(UNAVAILABLE));
  assert.doesNotMatch(unavailableBlock, new RegExp(WAITING));
  assert.doesNotMatch(unavailableBlock, new RegExp(EMPTY));
  assert.match(emptyBlock, new RegExp(EMPTY));
  assert.doesNotMatch(emptyBlock.slice(0, 400), new RegExp(WAITING));
  assert.doesNotMatch(emptyBlock.slice(0, 400), new RegExp(UNAVAILABLE));
});

test('LineageView history keeps loading / HTTP error / empty jsonl apart', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'LineageView.tsx'), 'utf8');

  assert.notEqual(HISTORY_LOADING, HISTORY_ERROR);
  assert.notEqual(HISTORY_ERROR, HISTORY_EMPTY);
  assert.match(src, new RegExp(`title="${HISTORY_LOADING}"`));
  assert.match(src, new RegExp(`title="${HISTORY_ERROR}"`));
  assert.match(src, new RegExp(`title="${HISTORY_EMPTY}"`));
  assert.match(src, /history\.error\?\.status/);
  assert.match(src, /HTTP \$\{history\.error\.status\}/);
  assert.match(src, /currentHistory\.error === undefined && foldedHistory\.length === 0/);
});
