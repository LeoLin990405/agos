import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_COPY,
  applyCancel,
  applyHostResult,
  applySessionChange,
  applySubmit,
  applyTransportError,
  canRetry,
  createApprovalRequest,
  displayCopy,
  isBusy,
  localPhaseAfterClick,
  sameApprovalToken,
  shouldDropMapping,
  type ApprovalState,
  type ApprovalToken,
} from './approval-state';

const tokenA: ApprovalToken = { callId: 'call-a', eventId: 'evt-a', sessionId: 'sess-a' };
const tokenB: ApprovalToken = { callId: 'call-b', eventId: 'evt-b', sessionId: 'sess-b' };
const tokenAOtherEvent: ApprovalToken = { callId: 'call-a', eventId: 'evt-other', sessionId: 'sess-a' };

function idle(token: ApprovalToken = tokenA): ApprovalState {
  return createApprovalRequest(token);
}

test('createApprovalRequest starts idle and keeps the mapping', () => {
  const state = idle();
  assert.equal(state.phase, 'idle');
  assert.equal(state.attempt, 0);
  assert.equal(state.retainMapping, true);
  assert.equal(state.detached, false);
  assert.equal(isBusy(state), false);
  assert.equal(canRetry(state), false);
  assert.equal(shouldDropMapping(state), false);
  assert.equal(displayCopy(state), '');
  assert.equal(sameApprovalToken(state.token, tokenA), true);
});

test('delayed success: pending then accepted is not resolved', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  assert.equal(pending.phase, 'pending');
  assert.equal(pending.submitted, 'allowed-once');
  assert.equal(pending.decision, undefined);
  assert.equal(isBusy(pending), true);
  assert.equal(canRetry(pending), false);
  assert.equal(shouldDropMapping(pending), false);
  assert.equal(displayCopy(pending), APPROVAL_COPY.pending);
  assert.doesNotMatch(displayCopy(pending), /已放行/);

  const accepted = applyHostResult(pending, tokenA, { kind: 'accepted' });
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.decision, undefined);
  assert.equal(isBusy(accepted), true);
  assert.equal(shouldDropMapping(accepted), false);
  assert.equal(displayCopy(accepted), APPROVAL_COPY.accepted);
  assert.doesNotMatch(displayCopy(accepted), /已放行/);

  const resolved = applyHostResult(accepted, tokenA, { kind: 'resolved', decision: 'allowed-once' });
  assert.equal(resolved.phase, 'resolved');
  assert.equal(resolved.decision, 'allowed-once');
  assert.equal(isBusy(resolved), false);
  assert.equal(canRetry(resolved), false);
  assert.equal(shouldDropMapping(resolved), true);
  assert.equal(displayCopy(resolved), APPROVAL_COPY.allowed);
});

test('host resolved evidence may arrive without a prior transport ack', () => {
  const pending = applySubmit(idle(), 'rejected');
  const resolved = applyHostResult(pending, tokenA, { kind: 'resolved', decision: 'rejected' });
  assert.equal(resolved.phase, 'resolved');
  assert.equal(resolved.decision, 'rejected');
  assert.equal(displayCopy(resolved), APPROVAL_COPY.rejected);
  assert.equal(shouldDropMapping(resolved), true);
});

test('explicit host reject of the POST stays retryable and keeps the map', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  const failed = applyTransportError(pending, tokenA, {
    kind: 'explicit',
    message: 'rpc already completed',
  });
  assert.equal(failed.phase, 'error');
  assert.equal(failed.failure?.kind, 'explicit');
  assert.equal(displayCopy(failed), 'rpc already completed');
  assert.equal(canRetry(failed), true);
  assert.equal(shouldDropMapping(failed), false);

  const retry = applySubmit(failed, 'allowed-once');
  assert.equal(retry.phase, 'pending');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.failure, undefined);
});

test('network error is recoverable and does not drop the map', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  const failed = applyTransportError(pending, tokenA, { kind: 'network' });
  assert.equal(failed.phase, 'error');
  assert.equal(displayCopy(failed), APPROVAL_COPY.network);
  assert.equal(canRetry(failed), true);
  assert.equal(shouldDropMapping(failed), false);
});

test('timeout and disconnect keep the mapping and allow retry', () => {
  const pending = applySubmit(idle(), 'rejected');
  const timedOut = applyTransportError(pending, tokenA, { kind: 'timeout' });
  assert.equal(displayCopy(timedOut), APPROVAL_COPY.timeout);
  assert.equal(canRetry(timedOut), true);
  assert.equal(shouldDropMapping(timedOut), false);

  const disconnected = applyTransportError(pending, tokenA, { kind: 'disconnect' });
  assert.equal(displayCopy(disconnected), APPROVAL_COPY.disconnect);
  assert.equal(canRetry(disconnected), true);
  assert.equal(shouldDropMapping(disconnected), false);
});

test('missing map is an accurate recoverable error', () => {
  const failed = applyTransportError(idle(), tokenA, { kind: 'missing-map' });
  assert.equal(failed.phase, 'error');
  assert.equal(displayCopy(failed), APPROVAL_COPY['missing-map']);
  assert.equal(canRetry(failed), true);
  assert.equal(isBusy(failed), false);
});

test('host cancel is terminal for this token and drops the map', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  const cancelled = applyCancel(pending, tokenA);
  assert.equal(cancelled.phase, 'error');
  assert.equal(cancelled.failure?.kind, 'cancelled');
  assert.equal(displayCopy(cancelled), APPROVAL_COPY.cancelled);
  assert.equal(canRetry(cancelled), false);
  assert.equal(shouldDropMapping(cancelled), true);
  assert.equal(applySubmit(cancelled, 'allowed-once'), cancelled);
});

test('double click while pending or accepted is ignored', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  assert.equal(applySubmit(pending, 'rejected'), pending);
  const accepted = applyHostResult(pending, tokenA, { kind: 'accepted' });
  assert.equal(applySubmit(accepted, 'rejected'), accepted);
  const resolved = applyHostResult(accepted, tokenA, { kind: 'resolved', decision: 'allowed-once' });
  assert.equal(applySubmit(resolved, 'rejected'), resolved);
});

test('host already handled with a decision is resolved evidence', () => {
  const handled = applyHostResult(idle(), tokenA, {
    kind: 'already-handled',
    decision: 'allowed-once',
  });
  assert.equal(handled.phase, 'resolved');
  assert.equal(handled.decision, 'allowed-once');
  assert.equal(displayCopy(handled), APPROVAL_COPY.allowed);
  assert.equal(shouldDropMapping(handled), true);
  assert.equal(canRetry(handled), false);
});

test('host already handled without a decision is stale, not a fake allow', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  const stale = applyHostResult(pending, tokenA, { kind: 'already-handled' });
  assert.equal(stale.phase, 'error');
  assert.equal(stale.failure?.kind, 'host-handled');
  assert.equal(displayCopy(stale), APPROVAL_COPY['host-handled']);
  assert.doesNotMatch(displayCopy(stale), /已放行/);
  assert.equal(canRetry(stale), false);
  assert.equal(shouldDropMapping(stale), true);
});

test('session switch hides this request and ignores another approval token', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  const detached = applySessionChange(pending, tokenB.sessionId);
  assert.equal(detached.detached, true);
  assert.equal(isBusy(detached), false);
  assert.equal(displayCopy(detached), APPROVAL_COPY['session-changed']);
  assert.doesNotMatch(displayCopy(detached), /已放行/);
  assert.equal(applySubmit(detached, 'rejected'), detached);
  assert.equal(shouldDropMapping(detached), false);

  const lateOther = applyHostResult(detached, tokenB, { kind: 'resolved', decision: 'allowed-once' });
  assert.equal(lateOther, detached);

  const lateOwn = applyHostResult(detached, tokenA, { kind: 'resolved', decision: 'allowed-once' });
  assert.equal(lateOwn.phase, 'resolved');
  assert.equal(lateOwn.decision, 'allowed-once');
  assert.equal(shouldDropMapping(lateOwn), true);
  assert.equal(displayCopy(lateOwn), APPROVAL_COPY['session-changed']);

  const back = applySessionChange(lateOwn, tokenA.sessionId);
  assert.equal(back.detached, false);
  assert.equal(displayCopy(back), APPROVAL_COPY.allowed);
});

test('late replies for another callId or eventId do not mutate this request', () => {
  const pending = applySubmit(idle(), 'allowed-once');
  assert.equal(applyHostResult(pending, tokenAOtherEvent, { kind: 'resolved', decision: 'rejected' }), pending);
  assert.equal(applyTransportError(pending, tokenB, { kind: 'network' }), pending);
  assert.equal(applyCancel(pending, tokenB), pending);
  assert.equal(pending.phase, 'pending');
});

test('transport ack after resolve cannot reopen or drop a later mapping', () => {
  const resolved = applyHostResult(applySubmit(idle(), 'allowed-once'), tokenA, {
    kind: 'resolved',
    decision: 'rejected',
  });
  assert.equal(applyHostResult(resolved, tokenA, { kind: 'accepted' }), resolved);
  assert.equal(applyTransportError(resolved, tokenA, { kind: 'network' }), resolved);
  assert.equal(applyCancel(resolved, tokenA), resolved);
});

test('local panel click never jumps to resolved', () => {
  assert.equal(localPhaseAfterClick('idle', false), 'pending');
  assert.equal(localPhaseAfterClick('error', false), 'pending');
  assert.equal(localPhaseAfterClick('idle', true), 'idle');
  assert.equal(localPhaseAfterClick('pending', false), 'pending');
  assert.equal(localPhaseAfterClick('accepted', false), 'accepted');
  assert.equal(localPhaseAfterClick('resolved', false), 'resolved');
});
