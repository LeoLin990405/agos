import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveChatConnectionState, type ChatConnectionSnapshot } from './chat-connection-state.ts';

const base: ChatConnectionSnapshot = {
  sessionsLoadedAt: 100,
  sessionsError: undefined,
  sessionCount: 1,
  muxPhase: 'online',
};

test('deriveChatConnectionState keeps the first connection quiet', () => {
  assert.equal(deriveChatConnectionState({ ...base, sessionsLoadedAt: 0, muxPhase: 'idle' }), 'connecting');
  assert.equal(deriveChatConnectionState({ ...base, muxPhase: 'connecting' }), 'connecting');
});

test('deriveChatConnectionState reports RPC and mux failures as disconnected', () => {
  assert.equal(deriveChatConnectionState({ ...base, sessionsError: 'session.list failed' }), 'disconnected');
  assert.equal(deriveChatConnectionState({ ...base, muxPhase: 'offline' }), 'disconnected');
});

test('deriveChatConnectionState distinguishes a connected empty workspace from a ready chat', () => {
  assert.equal(deriveChatConnectionState({ ...base, sessionCount: 0 }), 'empty');
  assert.equal(deriveChatConnectionState(base), 'ready');
});
