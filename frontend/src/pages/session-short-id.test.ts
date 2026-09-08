import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { shortSessionRef } from './session-short-id.ts'

/** 任务书写「会话首行」,但首行是 type:session,没有 parentSession。实际从同文件事件里取。 */
// Personal corpus reads are opt-in; ordinary npm test is synthetic and portable.
const CORPUS_ROOT = process.env.AGOS_SHORT_ID_CORPUS

function walkSessionFiles(root: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    const path = join(root, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) walkSessionFiles(path, out)
    else if (name === 'session.jsonl.zstd') out.push(path)
  }
  return out
}

/**
 * ⚠️ maxBuffer 原来是 8MB,解压超过它的会话文件触发 ENOBUFS(status=null),被下面
 * 那行 continue 当「坏文件」静默跳过 —— 语料因此是真实目录的子集,而断言用的是
 * 下界 `>= 62`,少几个父 id 也照绿(2026-08-22 验收 P2,实测本机今天恰好跳过 2 个
 * 文件、父 id 集合碰巧相同,是潜在态)。现在放到 512MB,并把跳过数抬成断言。
 */
const ZSTD_MAX_BUFFER = 512 * 1024 * 1024

function parentSessionsFromTrash(root: string): { parents: string[]; skipped: string[] } {
  const found: string[] = []
  const skipped: string[] = []
  for (const file of walkSessionFiles(root)) {
    const decoded = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: ZSTD_MAX_BUFFER })
    if (decoded.error !== undefined || decoded.status !== 0) { skipped.push(file); continue }
    if (!decoded.stdout) continue
    for (const line of decoded.stdout.split('\n')) {
      if (!line.includes('parentSession')) continue
      try {
        const obj = JSON.parse(line) as unknown
        const collect = (node: unknown): void => {
          if (Array.isArray(node)) {
            for (const item of node) collect(item)
            return
          }
          if (!node || typeof node !== 'object') return
          const rec = node as Record<string, unknown>
          if (typeof rec.parentSession === 'string' && rec.parentSession) found.push(rec.parentSession)
          for (const value of Object.values(rec)) collect(value)
        }
        collect(obj)
      } catch {
        // 坏行丢弃
      }
    }
  }
  return { parents: [...new Set(found)], skipped }
}

test('shortSessionRef uses uuid group or slug tail, not a fixed left slice', () => {
  assert.equal(shortSessionRef('session-ec978a30-1234-5678-9abc-def012345678'), 'ec978a30')
  assert.equal(shortSessionRef('ec978a30-1234-5678-9abc-def012345678'), 'ec978a30')
  assert.equal(shortSessionRef('preset-child-switch-parent'), 'chparent')
  assert.equal(shortSessionRef('preset-child-parent'), 'ldparent')
  assert.notEqual(shortSessionRef('preset-child-switch-parent'), shortSessionRef('preset-child-parent'))
  assert.equal('session-aaaaaaaa-1111-2222-3333-444444444444'.slice(0, 8), 'session-')
})

test('synthetic parent-session fixtures stay distinct without reading a personal corpus', () => {
  const parents = [
    ...Array.from({ length: 64 }, (_, index) => `session-${index.toString(16).padStart(8, '0')}-1234-5678-9abc-def012345678`),
    'preset-child-switch-parent', 'preset-child-parent',
  ]
  assert.equal(new Set(parents.map(shortSessionRef)).size, parents.length)
  assert.ok(parents.map(shortSessionRef).every((id) => id !== 'session-'))
})

test('explicitly selected parent-session corpus stays distinct', { skip: CORPUS_ROOT === undefined }, () => {
  assert.ok(CORPUS_ROOT)
  const { parents, skipped } = parentSessionsFromTrash(CORPUS_ROOT)
  // 语料必须是**整个**目录,不能是被 ENOBUFS 悄悄削掉的子集(见 ZSTD_MAX_BUFFER 注释)。
  assert.deepEqual(skipped, [], `解压失败被跳过的语料文件:\n${skipped.join('\n')}`)
  assert.ok(parents.length >= 62, `expected ≥62 unique parents from ${CORPUS_ROOT}, got ${parents.length}`)
  assert.ok(parents.includes('preset-child-switch-parent'))
  assert.ok(parents.includes('preset-child-parent'))
  const shorts = parents.map(shortSessionRef)
  assert.equal(new Set(shorts).size, parents.length, `collision among ${parents.length} real parents`)
  assert.ok(shorts.every((s) => s !== 'session-'))
})
