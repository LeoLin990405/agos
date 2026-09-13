/**
 * 真宿主浏览器核验聊天 P2:输入区不再假装有 Swarm 开关，发送与审批面仍在。
 * 不进九场景回归门;单独跑:
 *   node tests/host-integration/chat-p2.mjs
 */
import path from 'node:path'
import { createHarness } from './harness.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGINS = [{
  id: 'dsh-agos',
  entry: path.join(REPO_ROOT, 'plugins', 'dsh-agos', 'lib', 'index.js'),
  probe: { kind: 'http', path: '/api/agos/turn-evidence?sessionId=probe' },
}]

const checks = []
const record = (ok, detail) => {
  checks.push({ ok, detail })
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${detail}`)
}

const harness = await createHarness({ plugins: PLUGINS })
try {
  const sessionId = await harness.createSession('P2输入核验')
  await harness.openApp()
  await harness.selectSession(sessionId)
  const page = harness.page
  await page.locator('.chat-input-deck').waitFor({ timeout: 30_000 })
  const deck = await page.locator('.chat-input-deck').innerText()
  record(!deck.includes('Swarm 并发'), '输入区不再画未接入的 Swarm 并发开关')
  record(await page.getByRole('button', { name: '发送' }).count() > 0, '发送按钮仍在')
  record(await page.locator('.chat-textarea').count() > 0, '文本输入仍在')
} finally {
  await harness.dispose()
}

const failed = checks.filter((c) => !c.ok)
console.log(`chat-p2: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0 || checks.length === 0) process.exit(1)
