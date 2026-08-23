import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { readCodexBarUsage } from '../lib/usage.mjs'

const NOW = new Date('2026-08-21T00:10:00.000Z')

async function fixture({ rows = [], history = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cn-usage-'))
  const cacheDir = join(root, 'cache')
  const historyDir = join(root, 'history')
  await mkdir(cacheDir)
  await mkdir(historyDir)
  const cacheDbPath = join(cacheDir, 'Cache.db')
  const db = new DatabaseSync(cacheDbPath)
  db.exec(`
    CREATE TABLE cfurl_cache_response(entry_ID INTEGER PRIMARY KEY, request_key TEXT, time_stamp TEXT);
    CREATE TABLE cfurl_cache_receiver_data(entry_ID INTEGER PRIMARY KEY, receiver_data BLOB);
  `)
  const response = db.prepare('INSERT INTO cfurl_cache_response(entry_ID, request_key, time_stamp) VALUES (?, ?, ?)')
  const body = db.prepare('INSERT INTO cfurl_cache_receiver_data(entry_ID, receiver_data) VALUES (?, ?)')
  rows.forEach((row, index) => {
    const id = index + 1
    response.run(id, row.url, row.at || '2026-08-21 00:05:00')
    body.run(id, Buffer.from(JSON.stringify(row.body)))
  })
  db.close()
  for (const [id, entry] of Object.entries(history)) {
    await writeFile(join(historyDir, id + '.json'), JSON.stringify({ accounts: { test: [{ entries: [entry] }] } }))
  }
  return { root, cacheDbPath, historyDir }
}

test('normal cache parses history and provider responses without probing', async (t) => {
  const f = await fixture({
    history: { codex: { capturedAt: '2026-08-21T00:09:00Z', usedPercent: 25, resetsAt: '2026-08-22T00:00:00Z' } },
    rows: [
      { url: 'https://api.kimi.com/coding/v1/usages', body: { usage: { remaining: 80, limit: 100, resetTime: '2026-08-22T01:00:00Z' } } },
      { url: 'https://api.deepseek.com/user/balance', body: { balance_infos: [{ total_balance: '12.34', currency: 'CNY' }] } },
    ],
  })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const result = await readCodexBarUsage({ ...f, now: NOW })
  assert.equal(result.source, 'codexbar-cache')
  assert.equal(result.stale, false)
  // 缓存文件 mtime 是「最后一次有任何刷新」的唯一可信上界;raw.capturedAt 是条目创建时间,不是采集时间。
  assert.match(String(result.cacheMtime), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.providers.find((p) => p.id === 'codex'), {
    id: 'codex', label: 'Codex Pro', usedPct: 25, resetAt: '2026-08-22T00:00:00.000Z', raw: { capturedAt: '2026-08-21T00:09:00.000Z' },
  })
  assert.equal(result.providers.find((p) => p.id === 'kimi').remaining, 80)
  assert.equal(result.providers.find((p) => p.id === 'kimi').usedPct, 20)
  assert.equal(result.providers.find((p) => p.id === 'deepseek').remaining, '12.34')
})

test('missing Cache.db is a soft dependency: empty 200-shaped result with error', async () => {
  const result = await readCodexBarUsage({ cacheDbPath: join(tmpdir(), 'does-not-exist-codexbar.db'), historyDir: tmpdir(), now: NOW })
  assert.deepEqual(result.providers, [])
  assert.equal(result.stale, true)
  assert.equal(result.source, 'codexbar-cache')
  assert.match(result.error, /cache is unavailable/)
})

test('partial provider response is retained without inventing missing fields', async (t) => {
  const f = await fixture({ rows: [{ url: 'https://api.manus.im/user.v1.UserService/GetAvailableCredits', body: { totalCredits: 7 } }] })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const result = await readCodexBarUsage({ ...f, now: NOW })
  const manus = result.providers.find((p) => p.id === 'manus')
  assert.equal(manus.remaining, 7)
  assert.equal(manus.usedPct, undefined)
  assert.equal(manus.resetAt, undefined)
})
