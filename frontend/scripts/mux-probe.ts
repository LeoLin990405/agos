/**
 * W12 mux 帧计数探针(进程外,零冻结层改动,零上行消息):只收不发,按 type 计数,
 * 每 30s 与退出时把快照写到 ~/.dsh/logs/mux-probe.json。
 * 用法:nohup npm run mux-probe > /tmp/mux-probe.log 2>&1 &   (AGOS_PROBE_BASE 可覆盖)
 * 读数:cat ~/.dsh/logs/mux-probe.json
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgosClient, watchStream } from '../src/api-client/index.ts'
import { createProbeState, recordFrame, recordOpen, recordReconnect, snapshot } from '../src/lib/mux-probe-model.ts'

const BASE = process.env.AGOS_PROBE_BASE ?? 'http://127.0.0.1:3091'
const OUT = process.env.AGOS_PROBE_OUT ?? join(homedir(), '.dsh', 'logs', 'mux-probe.json')
const FLUSH_MS = 30_000

const client = createAgosClient({ baseUrl: BASE })
let state = createProbeState(Date.now())
let opened = 0

// 原子写:先写 tmp 再 rename,读者不会读到截断的半个 JSON。
const flush = (): void => {
  mkdirSync(join(OUT, '..'), { recursive: true })
  const tmp = `${OUT}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...snapshot(state, Date.now()), base: BASE }, null, 2))
  renameSync(tmp, OUT)
}

const stop = watchStream(
  (signal, onOpen) => client.mux(signal, () => { opened += 1; state = recordOpen(state, Date.now()); onOpen?.() }),
  // rpcId 只在是字符串时才传:缺席就让 reducer 走「无 rpcId 不去重」。
  (frame) => { state = recordFrame(state, { type: frame.payload.type, rpcId: typeof frame.rpcId === 'string' ? frame.rpcId : undefined }, Date.now()) },
  () => { state = recordReconnect(state) },
)

const timer = setInterval(flush, FLUSH_MS)
const bye = (): void => { clearInterval(timer); stop(); flush(); console.log(`[mux-probe] 已落盘 ${OUT}`); process.exit(0) }
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
console.log(`[mux-probe] 监听 ${BASE} 的 events.mux,每 ${FLUSH_MS / 1000}s 写 ${OUT}`)
