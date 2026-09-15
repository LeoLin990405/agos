import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyFollow,
  applyHandshake,
  applySocket,
  connectionHealthFromLive,
  deriveConnectionSurface,
  idleConnectionHealth,
  isFollowHealthy,
  isFullyHealthy,
} from './connection-health.ts'

test('a healthy global socket and handshake cannot hide this session follow failure', () => {
  let health = idleConnectionHealth()
  health = applySocket(health, { type: 'open' })
  health = applyHandshake(health, { type: 'ready', clientId: 'client-1' })
  health = applyFollow(health, { type: 'error', sessionId: 's1', error: 'follow reset' })

  assert.equal(health.socket.phase, 'open')
  assert.equal(health.handshake.phase, 'ready')
  assert.equal(health.follow.failed, true)
  assert.equal(health.follow.sessionId, 's1')
  assert.equal(isFollowHealthy(health), false)
  assert.equal(isFullyHealthy(health), false)
  assert.equal(deriveConnectionSurface(health), 'follow-unavailable')
})

test('follow stays independent when only the socket or handshake moves', () => {
  let health = idleConnectionHealth()
  health = applyFollow(health, { type: 'error', sessionId: 's1', error: 'stream missing' })
  health = applySocket(health, { type: 'connecting' })
  assert.equal(health.follow.failed, true)
  assert.equal(deriveConnectionSurface(health), 'connecting')

  health = applySocket(health, { type: 'open' })
  health = applyHandshake(health, { type: 'pending' })
  assert.equal(health.follow.phase, 'error')
  assert.equal(deriveConnectionSurface(health), 'connecting')

  health = applyHandshake(health, { type: 'ready', clientId: 'c' })
  assert.equal(deriveConnectionSurface(health), 'follow-unavailable')

  health = applyHandshake(health, { type: 'failed', error: 'no ready frame' })
  assert.equal(health.follow.failed, true, 'handshake failure must not clear follow failure')
  assert.equal(deriveConnectionSurface(health), 'handshake-failed')
})

test('socket down is disconnected even if a previous follow looked live', () => {
  let health = idleConnectionHealth()
  health = applySocket(health, { type: 'open' })
  health = applyHandshake(health, { type: 'ready', clientId: 'c' })
  health = applyFollow(health, { type: 'live', sessionId: 's1' })
  assert.equal(isFullyHealthy(health), true)
  assert.equal(deriveConnectionSurface(health), 'ready')

  health = applySocket(health, { type: 'closed' })
  assert.equal(health.follow.phase, 'live', 'socket event does not rewrite follow axis')
  assert.equal(deriveConnectionSurface(health), 'disconnected')
})

test('connectionHealthFromLive maps mux online + this-session error to follow-unavailable', () => {
  const healthyMuxBrokenFollow = connectionHealthFromLive({
    muxPhase: 'online',
    clientId: 'ready-client',
    sessionId: 's9',
    followPhase: 'error',
    followError: 'session/follow failed',
  })
  assert.equal(healthyMuxBrokenFollow.socket.phase, 'open')
  assert.equal(healthyMuxBrokenFollow.handshake.phase, 'ready')
  assert.equal(healthyMuxBrokenFollow.follow.failed, true)
  assert.equal(deriveConnectionSurface(healthyMuxBrokenFollow), 'follow-unavailable')

  const connecting = connectionHealthFromLive({
    muxPhase: 'connecting',
    sessionId: 's9',
    followPhase: 'loading',
  })
  assert.equal(deriveConnectionSurface(connecting), 'connecting')

  const ready = connectionHealthFromLive({
    muxPhase: 'online',
    clientId: 'ready-client',
    sessionId: 's9',
    followPhase: 'live',
  })
  assert.equal(deriveConnectionSurface(ready), 'ready')
  assert.equal(isFullyHealthy(ready), true)
})

test('no current session can be ready at the mux without inventing a follow', () => {
  const health = connectionHealthFromLive({
    muxPhase: 'online',
    clientId: 'ready-client',
    followPhase: 'idle',
  })
  assert.equal(health.follow.phase, 'idle')
  assert.equal(health.follow.failed, false)
  assert.equal(isFollowHealthy(health), false)
  assert.equal(deriveConnectionSurface(health), 'ready')
})
