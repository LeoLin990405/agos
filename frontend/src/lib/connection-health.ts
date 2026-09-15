/**
 * Independent connection health: global socket, handshake, current-session follow.
 *
 * chat-connection-state.ts only sees the mux phase + session list. A healthy
 * socket must not hide this session's follow failure — that is the whole point
 * of this model. The controller can adopt these fields; do not edit the old
 * mux-only helper from here.
 */

export type SocketPhase = 'idle' | 'connecting' | 'open' | 'closed' | 'error'
export type HandshakePhase = 'idle' | 'pending' | 'ready' | 'failed'
export type FollowPhase = 'idle' | 'connecting' | 'live' | 'error' | 'reconnecting'

export interface SocketHealth {
  phase: SocketPhase
  error?: string
}

export interface HandshakeHealth {
  phase: HandshakePhase
  clientId?: string
  error?: string
}

export interface FollowHealth {
  sessionId?: string
  phase: FollowPhase
  error?: string
  /** This session's follow is unhealthy, regardless of socket/handshake. */
  failed: boolean
}

export interface ConnectionHealth {
  socket: SocketHealth
  handshake: HandshakeHealth
  follow: FollowHealth
}

export type SocketEvent =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'closed'; error?: string }
  | { type: 'error'; error?: string }

export type HandshakeEvent =
  | { type: 'pending' }
  | { type: 'ready'; clientId?: string }
  | { type: 'failed'; error?: string }
  | { type: 'reset' }

export type FollowEvent =
  | { type: 'connecting'; sessionId: string }
  | { type: 'live'; sessionId: string }
  | { type: 'error'; sessionId: string; error?: string }
  | { type: 'reconnecting'; sessionId: string }
  | { type: 'idle' }

export type ConnectionSurface =
  | 'idle'
  | 'connecting'
  | 'disconnected'
  | 'handshake-failed'
  | 'follow-unavailable'
  | 'ready'

export type LiveMuxPhase = 'idle' | 'connecting' | 'online' | 'offline'
export type LiveConversationPhase = 'idle' | 'loading' | 'live' | 'error'

export function idleConnectionHealth(): ConnectionHealth {
  return {
    socket: { phase: 'idle' },
    handshake: { phase: 'idle' },
    follow: { phase: 'idle', failed: false },
  }
}

export function applySocket(health: ConnectionHealth, event: SocketEvent): ConnectionHealth {
  switch (event.type) {
    case 'connecting':
      return { ...health, socket: { phase: 'connecting' } }
    case 'open':
      return { ...health, socket: { phase: 'open' } }
    case 'closed':
      return { ...health, socket: withError({ phase: 'closed' }, event.error) }
    case 'error':
      return { ...health, socket: withError({ phase: 'error' }, event.error) }
  }
}

export function applyHandshake(health: ConnectionHealth, event: HandshakeEvent): ConnectionHealth {
  switch (event.type) {
    case 'pending':
      return { ...health, handshake: { phase: 'pending' } }
    case 'ready':
      return {
        ...health,
        handshake: event.clientId !== undefined && event.clientId !== ''
          ? { phase: 'ready', clientId: event.clientId }
          : { phase: 'ready' },
      }
    case 'failed':
      return { ...health, handshake: withError({ phase: 'failed' }, event.error) }
    case 'reset':
      return { ...health, handshake: { phase: 'idle' } }
  }
}

export function applyFollow(health: ConnectionHealth, event: FollowEvent): ConnectionHealth {
  switch (event.type) {
    case 'idle':
      return { ...health, follow: { phase: 'idle', failed: false } }
    case 'connecting':
      return { ...health, follow: { sessionId: event.sessionId, phase: 'connecting', failed: false } }
    case 'live':
      return { ...health, follow: { sessionId: event.sessionId, phase: 'live', failed: false } }
    case 'reconnecting':
      return { ...health, follow: { sessionId: event.sessionId, phase: 'reconnecting', failed: false } }
    case 'error':
      return {
        ...health,
        follow: {
          sessionId: event.sessionId,
          phase: 'error',
          failed: true,
          ...(event.error !== undefined && event.error !== '' ? { error: event.error } : {}),
        },
      }
  }
}

/**
 * Surface derivation. Order is deliberate: a live mux/socket cannot conclude
 * `ready` while this session's follow has failed.
 */
export function deriveConnectionSurface(health: ConnectionHealth): ConnectionSurface {
  const { socket, handshake, follow } = health
  if (socket.phase === 'error' || socket.phase === 'closed') return 'disconnected'
  if (socket.phase === 'idle') return 'idle'
  if (socket.phase === 'connecting') return 'connecting'
  if (handshake.phase === 'failed') return 'handshake-failed'
  if (handshake.phase === 'idle' || handshake.phase === 'pending') return 'connecting'
  if (follow.failed || follow.phase === 'error') return 'follow-unavailable'
  if (follow.phase === 'connecting' || follow.phase === 'reconnecting') return 'connecting'
  return 'ready'
}

export function isFollowHealthy(health: ConnectionHealth): boolean {
  return health.follow.phase === 'live' && health.follow.failed === false
}

export function isFullyHealthy(health: ConnectionHealth): boolean {
  return health.socket.phase === 'open'
    && health.handshake.phase === 'ready'
    && isFollowHealthy(health)
}

export function socketFromLivePhase(phase: LiveMuxPhase): SocketPhase {
  switch (phase) {
    case 'idle': return 'idle'
    case 'connecting': return 'connecting'
    case 'online': return 'open'
    case 'offline': return 'closed'
  }
}

export function followFromConversationPhase(
  sessionId: string | undefined,
  phase: LiveConversationPhase,
  error?: string,
): FollowHealth {
  if (sessionId === undefined || sessionId === '') return { phase: 'idle', failed: false }
  switch (phase) {
    case 'idle':
      return { sessionId, phase: 'idle', failed: false }
    case 'loading':
      return { sessionId, phase: 'connecting', failed: false }
    case 'live':
      return { sessionId, phase: 'live', failed: false }
    case 'error':
      return {
        sessionId,
        phase: 'error',
        failed: true,
        ...(error !== undefined && error !== '' ? { error } : {}),
      }
  }
}

export function handshakeFromReady(clientId: string | undefined, socketOpen: boolean): HandshakeHealth {
  if (!socketOpen) return { phase: 'idle' }
  if (clientId !== undefined && clientId !== '') return { phase: 'ready', clientId }
  return { phase: 'pending' }
}

/** Map today's live.ts fields into the richer three-axis model. */
export function connectionHealthFromLive(input: {
  muxPhase: LiveMuxPhase
  clientId?: string
  sessionId?: string
  followPhase: LiveConversationPhase
  followError?: string
  socketError?: string
  handshakeError?: string
}): ConnectionHealth {
  const socketPhase = socketFromLivePhase(input.muxPhase)
  const socketOpen = socketPhase === 'open'
  const socket: SocketHealth = input.socketError !== undefined && input.socketError !== ''
    ? { phase: socketPhase, error: input.socketError }
    : { phase: socketPhase }
  let handshake = handshakeFromReady(input.clientId, socketOpen)
  if (input.handshakeError !== undefined && input.handshakeError !== '') {
    handshake = { phase: 'failed', error: input.handshakeError }
  }
  return {
    socket,
    handshake,
    follow: followFromConversationPhase(input.sessionId, input.followPhase, input.followError),
  }
}

function withError<T extends { phase: string }>(base: T, error: string | undefined): T & { error?: string } {
  return error !== undefined && error !== '' ? { ...base, error } : base
}
