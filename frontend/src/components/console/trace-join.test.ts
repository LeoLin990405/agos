import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TRACE_JOIN_COPY, TRACE_JOIN_COUNT_COPY, traceJoinId } from './trace-join.ts'

test('traceJoinId uses rawId only and never invents a prefix', () => {
  const raw = 'session-ec978a30-1234-5678-9abc-def012345678'
  assert.equal(traceJoinId(raw), raw)
  assert.equal(traceJoinId('ec978a30-1234-5678-9abc-def012345678'), undefined)
  assert.equal(traceJoinId(''), undefined)
  assert.equal(traceJoinId(undefined), undefined)
  assert.equal(traceJoinId('  '), undefined)
})

test('TraceView joins with rawId and the success-only 接入 copy', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'TraceView.tsx'), 'utf8')
  assert.match(src, /traceJoinId\(/)
  assert.match(src, /TRACE_JOIN_COPY/)
  assert.match(src, /onSelectSession/)
  assert.doesNotMatch(src, /session-\$\{/)
  assert.equal(TRACE_JOIN_COPY, '接入该会话')
})

/**
 * ⚠️ 上面那三条源锁一条也锁不住按钮:把 <Button> 整块删掉,/traceJoinId\(/ 被 joinId 那行
 * 满足、/TRACE_JOIN_COPY/ 被计数行满足、/onSelectSession/ 被 props 类型签名满足 —— 全绿。
 * OpenCLI extract 读不到 <button> 文案,回归也拦不住。所以按钮只能由这条源锁守
 * (2026-08-22 验收 P1)。
 */
test('接入按钮本体被源锁守住：删掉它这条必红', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'TraceView.tsx'), 'utf8')
  // 按钮标签 + onClick 把 joinId 交出去，三者必须在同一个 <Button> 里。
  assert.match(
    src,
    /<Button[\s\S]{0,240}onSelectSession\?\.\(joinId\)[\s\S]{0,120}TRACE_JOIN_COPY/,
    '带 onSelectSession(joinId) 的接入按钮不见了',
  )
})

test('归档会话不给接入按钮，计数与按钮同源 (TASK-019 验收 P1)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'TraceView.tsx'), 'utf8')
  // 可接入与否只有 joinIdOf 一个判断入口，按钮和计数都读它。
  assert.match(src, /const joinIdOf = /)
  assert.match(src, /!hiddenIds\.has\(id\)/, '归档集没有参与可接入判定')
  assert.match(src, /const joinId = joinIdOf\(r\)/, '按钮没走 joinIdOf')
  assert.match(src, /joinableCount = rows\.filter\(\(r\) => joinIdOf\(r\) !== undefined\)/)
  assert.match(src, /TRACE_JOIN_COUNT_COPY\(joinableCount\)/)
  // 归档集来自 /api/agos/session-meta，与对话页守卫读的是同一份。
  assert.match(src, /\/api\/agos\/session-meta/)
  // 回归锚不能再是按钮标签的复制品。
  assert.notEqual(TRACE_JOIN_COUNT_COPY(2), TRACE_JOIN_COPY)
  assert.equal(TRACE_JOIN_COUNT_COPY(2), '可接入 2 条会话')
})
