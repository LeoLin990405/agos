/** W3 能量 VAD 状态机测试(纯函数,零音频设备)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeLevel, createVadState, vadTick, VAD_DEFAULTS, type VadState } from './vad-model.ts'

test('computeLevel:静音≈0,满幅=1', () => {
  assert.equal(computeLevel([]), 0)
  assert.equal(computeLevel(new Uint8Array(64).fill(128)), 0)
  const loud = new Uint8Array(64).fill(255)
  assert.ok(computeLevel(loud) > 0.9)
  const quiet = new Uint8Array(64).fill(130)
  assert.ok(computeLevel(quiet) < 0.03)
})

test('没说过话永不自动停', () => {
  let state: VadState = createVadState()
  for (let t = 0; t <= 5000; t += 100) {
    const r = vadTick(state, 0.001, t, VAD_DEFAULTS)
    state = r.state
    assert.equal(r.shouldStop, false)
  }
})

test('说过话后静音 1.5s 自动停', () => {
  let state: VadState = createVadState()
  // 100-400ms 有人声
  for (const t of [100, 200, 300, 400]) state = vadTick(state, 0.2, t, VAD_DEFAULTS).state
  assert.equal(state.hasSpeech, true)
  // 500ms 起静音;1900ms(静音 1400ms)不停,2000ms(静音 1500ms)停
  let r = vadTick(state, 0.001, 500, VAD_DEFAULTS)
  assert.equal(r.shouldStop, false)
  r = vadTick(r.state, 0.001, 1900, VAD_DEFAULTS)
  assert.equal(r.shouldStop, false)
  r = vadTick(r.state, 0.001, 2000, VAD_DEFAULTS)
  assert.equal(r.shouldStop, true)
})

test('静音中恢复说话会重置计时', () => {
  let state: VadState = createVadState()
  state = vadTick(state, 0.2, 0, VAD_DEFAULTS).state
  state = vadTick(state, 0.001, 100, VAD_DEFAULTS).state
  state = vadTick(state, 0.2, 1200, VAD_DEFAULTS).state   // 又说
  assert.equal(state.silenceSince, undefined)
  const r = vadTick(state, 0.001, 1200 + 1400, VAD_DEFAULTS)
  assert.equal(r.shouldStop, false)
})

test('silenceMs=0 语义由调用方禁用;状态机本身不特判', () => {
  let state: VadState = createVadState()
  // setup 改成持续发声 250ms:本用例验的是 silenceMs=0 的超时语义,而 hasSpeech 的
  // latch 条件在 2026-08-21 验收里从「单帧」改成「持续 minSpeechMs」(瞬时尖峰
  // 会让一次门响触发自动停并把静音送去 ASR)。断言本身一字未改。
  for (let t = 0; t <= 250; t += 50) {
    state = vadTick(state, 0.2, t, { silenceMs: 0, threshold: 0.02 }).state
  }
  const r = vadTick(state, 0.001, 300, { silenceMs: 0, threshold: 0.02 })
  assert.equal(r.shouldStop, true) // 纯状态机:silenceMs=0 即立即超时;禁用逻辑在组件层
})

test('单个瞬时尖峰不 latch hasSpeech,因此不会触发自动停', () => {
  // 一次门响/键盘声:t=0 过门限一帧,之后全静音。
  let st = createVadState();
  st = vadTick(st, 0.9, 0).state;                       // 尖峰起始
  assert.equal(st.hasSpeech, false, '持续不足 minSpeechMs 时不得 latch');
  for (let t = 66; t <= 4000; t += 66) {
    const r = vadTick(st, 0.001, t);
    st = r.state;
    assert.equal(r.shouldStop, false, `t=${t} 不该自动停`);
  }
});

test('持续说话满 minSpeechMs 才 latch,随后静音超时才停', () => {
  let st = createVadState();
  for (let t = 0; t <= 300; t += 66) st = vadTick(st, 0.5, t).state;
  assert.equal(st.hasSpeech, true, '持续 300ms > 默认 200ms 应 latch');
  let stopped = false;
  for (let t = 366; t <= 2200 && !stopped; t += 66) {
    const r = vadTick(st, 0.001, t);
    st = r.state; stopped = r.shouldStop;
  }
  assert.equal(stopped, true, '静音超过 silenceMs 应自动停');
});
