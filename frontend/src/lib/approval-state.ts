/**
 * Approval submit state machine.
 *
 * Clicking allow is not authorization. `accepted` means the client/transport
 * took the respond POST; `resolved` is only for matching host protocol evidence
 * (approval/decided or an equivalent already-handled outcome). The waterfall
 * map must stay until that evidence (or a proven-stale cancel / already-handled
 * for *this* token).
 *
 * live.ts / transcript stay controller-owned. Call these reducers from there;
 * do not invent an always-allow RPC — host respond is only allowed-once | rejected.
 */

export type ApprovalPhase = 'idle' | 'pending' | 'accepted' | 'resolved' | 'error';

export type ApprovalDecision = 'allowed-once' | 'rejected';

export type ApprovalFailureKind =
  | 'network'
  | 'timeout'
  | 'disconnect'
  | 'missing-map'
  | 'explicit'
  | 'cancelled'
  | 'host-handled'
  | 'session-changed';

export interface ApprovalToken {
  readonly callId: string;
  readonly eventId: string;
  readonly sessionId: string;
}

export interface ApprovalFailure {
  readonly kind: ApprovalFailureKind;
  readonly message: string;
}

export interface ApprovalState {
  readonly phase: ApprovalPhase;
  readonly token: ApprovalToken;
  /** Decision the user last tried to submit. */
  readonly submitted?: ApprovalDecision;
  /** Host-evident decision. Only set in `resolved`. */
  readonly decision?: ApprovalDecision;
  readonly failure?: ApprovalFailure;
  readonly attempt: number;
  /** Keep the live.ts callId→eventId row until host evidence or proven stale. */
  readonly retainMapping: boolean;
  /** UI is looking at another session than this token. */
  readonly detached: boolean;
}

export type ApprovalHostResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'resolved'; readonly decision: ApprovalDecision }
  | { readonly kind: 'already-handled'; readonly decision?: ApprovalDecision };

export interface ApprovalTransportError {
  readonly kind: Exclude<ApprovalFailureKind, 'cancelled' | 'host-handled' | 'session-changed'>;
  readonly message?: string;
}

export const APPROVAL_COPY = {
  pending: '正在提交审批，尚未生效',
  accepted: '请求已送达，等待宿主授权生效',
  allowed: '已放行:本次特权执行已授权',
  rejected: '已拒绝:本次特权执行已中止',
  network: '提交失败：网络错误，审批未确认生效，可重试',
  timeout: '提交超时，审批未确认生效，可重试',
  disconnect: '连接已断开，审批未确认生效，可重试',
  'missing-map': '当前没有可应答的审批通道，可重试',
  explicit: '宿主拒绝了本次提交，审批未生效，可重试',
  cancelled: '宿主已撤回本次审批',
  'host-handled': '宿主已处理本次审批',
  'session-changed': '已切换会话，本次提交不作用于当前会话',
} as const;

const RETRYABLE: ReadonlySet<ApprovalFailureKind> = new Set([
  'network',
  'timeout',
  'disconnect',
  'missing-map',
  'explicit',
]);

export function sameApprovalToken(a: ApprovalToken, b: ApprovalToken): boolean {
  return a.callId === b.callId && a.eventId === b.eventId && a.sessionId === b.sessionId;
}

export function createApprovalRequest(token: ApprovalToken): ApprovalState {
  return {
    phase: 'idle',
    token: {
      callId: token.callId,
      eventId: token.eventId,
      sessionId: token.sessionId,
    },
    attempt: 0,
    retainMapping: true,
    detached: false,
  };
}

export function isBusy(state: ApprovalState): boolean {
  return !state.detached && (state.phase === 'pending' || state.phase === 'accepted');
}

export function canRetry(state: ApprovalState): boolean {
  if (state.detached || state.phase !== 'error' || state.failure === undefined) return false;
  return RETRYABLE.has(state.failure.kind);
}

export function shouldDropMapping(state: ApprovalState): boolean {
  return !state.retainMapping;
}

export function displayCopy(state: ApprovalState): string {
  if (state.detached) return APPROVAL_COPY['session-changed'];
  return displayCopyForView({
    phase: state.phase,
    decision: state.decision,
    failureKind: state.failure?.kind,
    error: state.failure?.message,
  });
}

export function displayCopyForView(input: {
  phase: ApprovalPhase;
  decision?: ApprovalDecision;
  failureKind?: ApprovalFailureKind;
  error?: string;
}): string {
  switch (input.phase) {
    case 'idle':
      return '';
    case 'pending':
      return APPROVAL_COPY.pending;
    case 'accepted':
      return APPROVAL_COPY.accepted;
    case 'resolved':
      if (input.decision === 'rejected') return APPROVAL_COPY.rejected;
      if (input.decision === 'allowed-once') return APPROVAL_COPY.allowed;
      return APPROVAL_COPY.accepted;
    case 'error':
      if (input.error !== undefined && input.error.trim() !== '') return input.error;
      return input.failureKind === undefined
        ? APPROVAL_COPY.explicit
        : APPROVAL_COPY[input.failureKind];
  }
}

/** Uncontrolled panel click: never jump to resolved. */
export function localPhaseAfterClick(
  phase: ApprovalPhase,
  blocked: boolean,
): ApprovalPhase {
  if (blocked) return phase;
  if (phase === 'idle' || phase === 'error') return 'pending';
  return phase;
}

export function applySubmit(state: ApprovalState, decision: ApprovalDecision): ApprovalState {
  if (state.detached) return state;
  if (state.phase === 'pending' || state.phase === 'accepted' || state.phase === 'resolved') return state;
  if (state.phase === 'error' && !canRetry(state)) return state;
  return {
    ...state,
    phase: 'pending',
    submitted: decision,
    decision: undefined,
    failure: undefined,
    attempt: state.attempt + 1,
    retainMapping: true,
  };
}

export function applyHostResult(
  state: ApprovalState,
  token: ApprovalToken,
  result: ApprovalHostResult,
): ApprovalState {
  if (!sameApprovalToken(state.token, token)) return state;
  if (state.phase === 'resolved') return state;

  if (result.kind === 'accepted') {
    if (state.phase !== 'pending' && state.phase !== 'idle') return state;
    return {
      ...state,
      phase: 'accepted',
      failure: undefined,
      retainMapping: true,
    };
  }

  if (result.kind === 'resolved') {
    return {
      ...state,
      phase: 'resolved',
      decision: result.decision,
      failure: undefined,
      retainMapping: false,
    };
  }

  if (result.decision !== undefined) {
    return {
      ...state,
      phase: 'resolved',
      decision: result.decision,
      failure: undefined,
      retainMapping: false,
    };
  }

  return {
    ...state,
    phase: 'error',
    failure: { kind: 'host-handled', message: APPROVAL_COPY['host-handled'] },
    retainMapping: false,
  };
}

export function applyTransportError(
  state: ApprovalState,
  token: ApprovalToken,
  error: ApprovalTransportError,
): ApprovalState {
  if (!sameApprovalToken(state.token, token)) return state;
  if (state.phase === 'resolved') return state;
  const message = (error.message !== undefined && error.message.trim() !== '')
    ? error.message
    : APPROVAL_COPY[error.kind];
  return {
    ...state,
    phase: 'error',
    failure: { kind: error.kind, message },
    retainMapping: true,
  };
}

export function applyCancel(state: ApprovalState, token: ApprovalToken): ApprovalState {
  if (!sameApprovalToken(state.token, token)) return state;
  if (state.phase === 'resolved') return state;
  return {
    ...state,
    phase: 'error',
    failure: { kind: 'cancelled', message: APPROVAL_COPY.cancelled },
    retainMapping: false,
  };
}

export function applySessionChange(state: ApprovalState, sessionId: string): ApprovalState {
  const detached = sessionId !== state.token.sessionId;
  if (state.detached === detached) return state;
  return { ...state, detached };
}
