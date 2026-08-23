import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { shortCircuit: true, url: 'data:text/javascript,export%20{}' };
    return nextResolve(specifier, context);
  },
});

const { TranscriptBody } = await import('./chat-transcript');
const { groupYoloByCallId, parseYoloDecisionsPayload } = await import('@/components/chat/yolo-decisions');

// 照归档会话 session-0b4b785c 的真实序列:tool/call(bash) → approval/asked → approval/decided(rejected) → tool/result(isError)。
const S = 'session-0b4b785c-1e7c-4223-bf0e-371d7f75b690';
const CALL = 'call_00_f7122htIGP1mryoaTTME3256';
const snapshot = {
  header: { sessionId: S, cwd: '/Users/leo', createdAt: 1, origin: 'top', parentSession: undefined, delegationDepth: 0, agentPreset: undefined, subagentLabel: undefined },
  title: undefined,
  items: [
    { kind: 'tool', callId: CALL, name: 'bash', argsRaw: '{"command":"touch /Users/Shared/yolo-probe.txt"}', turn: 3, step: 2, startAt: 1787056810000, endAt: 1787056815349, status: 'failed', resultText: 'Error: the user rejected escalating this command to "danger-full-access"' },
    { kind: 'approval', id: '6c9a8520', toolName: 'bash', callId: CALL, reason: 'escalate sandbox to danger-full-access', at: 1787056810354, outcome: 'rejected' },
  ],
  turnsStarted: 1, turnsEnded: 1, lastTurnEndReason: undefined, todos: [], planMode: false, sandboxMode: undefined, approvalPolicy: undefined, queuedUserTexts: [],
  diagnostics: { ignored: {}, unknown: {}, parseErrors: 0, orphanResults: 0, compactionPrunes: 0 },
} as never;

const render = (yolo: ReadonlyMap<string, never[]> | undefined): string => renderToStaticMarkup(
  React.createElement(TranscriptBody, { sessionId: S, snapshot, phase: 'live', error: undefined, readOnly: true, ...(yolo ? { yoloByCallId: yolo } : {}) } as never),
);

test('没有裁决台账时,审批行维持事件流结果;有裁决行时说清「谁拒的」,修复前格式写「裁判未留理由」', () => {
  const plain = render(undefined);
  assert.match(plain, /审批 bash:rejected/);
  assert.doesNotMatch(plain, /LLM 裁判/);
  const judged = groupYoloByCallId(parseYoloDecisionsPayload({ version: 1, sessionId: S, count: 1, items: [
    { time: 1787056815348, callId: CALL, toolName: 'bash', origin: 'main', targetMode: 'danger-full-access', currentMode: 'workspace-write', justification: '用户明确要求在工作区外创建', decision: 'judge', outcome: 'rejected' },
  ] }).items) as ReadonlyMap<string, never[]>;
  const html = render(judged);
  assert.match(html, /审批 bash:LLM 裁判拒绝（裁判未留理由）/);
  assert.match(html, /data-yolo="judge"/);
  // bash 卡上方也挂了同一裁决 chip(注解,不是第三条 item)。
  assert.equal((html.match(/LLM 裁判拒绝（裁判未留理由）/g) ?? []).length, 2);
  // 申请方的 justification 不会被当成裁决理由印出来。
  assert.doesNotMatch(html, /用户明确要求在工作区外创建/);
});

test('有 reason 的裁决行把理由印出来;转人工与放行各有文案', () => {
  const mk = (decision: string, outcome: string, reason?: string) => groupYoloByCallId(parseYoloDecisionsPayload({ version: 1, sessionId: S, count: 1, items: [
    { time: 1, callId: CALL, decision, outcome, ...(reason ? { reason } : {}) },
  ] }).items) as ReadonlyMap<string, never[]>;
  assert.match(render(mk('deny', 'rejected', 'scope exceeds need')), /策略直接拒绝：scope exceeds need/);
  assert.match(render(mk('judge', 'delegate')), /裁判转人工审批/);
  assert.match(render(mk('judge', 'allowed-once', 'ok')), /LLM 裁判放行（一次）：ok/);
});
