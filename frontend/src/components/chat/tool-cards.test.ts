import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chatToolCardKind,
  fileToolPath,
  fileToolPathTail,
  isFileToolName,
  QUEUED_COUNT_COPY,
  QUEUE_WHILE_RUNNING_COPY,
  sessionPromptMode,
} from './tool-cards.ts';

test('工具卡分流：swarm 行优先，bash 进终端，读写进文件，其余通用', () => {
  assert.equal(chatToolCardKind({ name: 'write', swarm: [{ index: 0 }] }), 'swarm');
  assert.equal(chatToolCardKind({ name: 'bash', argsRaw: '{"command":"ls"}' }), 'bash');
  assert.equal(chatToolCardKind({ name: 'write', argsRaw: '{"file_path":"/a.ts"}' }), 'file');
  assert.equal(chatToolCardKind({ name: 'Read', argsRaw: '{"file_path":"/a.ts"}' }), 'file');
  assert.equal(chatToolCardKind({ name: 'todo_write' }), 'generic');
  assert.equal(chatToolCardKind({ name: 'grep' }), 'generic');
  assert.equal(chatToolCardKind({ name: 'web_fetch' }), 'generic');
});

test('文件卡路径只认真实键，todo/search 不当文件工具', () => {
  assert.equal(isFileToolName('todo_write'), false);
  assert.equal(isFileToolName('grep'), false);
  assert.equal(fileToolPath('{"file_path":"/tmp/a.ts"}'), '/tmp/a.ts');
  assert.equal(fileToolPath('{"file":"notes.md"}'), 'notes.md');
  assert.equal(fileToolPath('{"pattern":"foo"}'), undefined);
  assert.equal(fileToolPath('not-json'), undefined);
  assert.equal(fileToolPathTail('/Users/leo/a.ts'), 'a.ts');
  assert.equal(fileToolPathTail(undefined), undefined);
});

test('运行中排队、空闲 steer；文案不含虚构 swarm 开关', () => {
  assert.equal(sessionPromptMode(true), 'queue');
  assert.equal(sessionPromptMode(false), 'steer');
  assert.equal(QUEUED_COUNT_COPY(2), '已排队 2 条，当前回合结束后发送');
  assert.match(QUEUE_WHILE_RUNNING_COPY, /排队/);
});

test('对话流接线：四类卡都在，通用时间线不再吞文件卡', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../pages/chat-transcript.tsx'), 'utf8');
  assert.match(src, /chatToolCardKind/);
  assert.match(src, /FileToolCard/);
  assert.match(src, /SwarmBatchCard/);
  assert.match(src, /TerminalCard/);
  assert.match(src, /ApprovalPanel/);
  assert.match(src, /chatToolCardKind\(item\) === 'file'/);
});

test('输入区不得再画未接入的 Swarm 并发开关', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'CommandDeck.tsx'), 'utf8');
  assert.doesNotMatch(src, /Swarm 并发/);
  assert.doesNotMatch(src, /swarmMode/);
  assert.match(src, /QUEUE_WHILE_RUNNING_COPY|sessionRunning/);
});
