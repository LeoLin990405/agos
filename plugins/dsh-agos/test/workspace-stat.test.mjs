import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertUsableWorkspace,
  createWorkspaceStatRoute,
  inspectWorkspacePath,
} from '../lib/workspace-stat.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agos-cwd-'))
  const dir = join(root, 'workspace')
  mkdirSync(dir)
  const file = join(root, 'notes.txt')
  writeFileSync(file, 'x')
  const missing = join(root, 'does-not-exist')
  const link = join(root, 'via-link')
  symlinkSync(dir, link)
  return { root, dir, file, missing, link }
}

test('inspectWorkspacePath: 绝对目录 / 文件 / 缺失 / 相对路径', () => {
  const { dir, file, missing } = fixture()
  try {
    assert.deepEqual(inspectWorkspacePath(dir), { ok: true, exists: true, isDirectory: true })
    assert.deepEqual(inspectWorkspacePath(` ${dir} `), { ok: true, exists: true, isDirectory: true })
    assert.deepEqual(inspectWorkspacePath(file), { ok: true, exists: true, isDirectory: false })
    assert.deepEqual(inspectWorkspacePath(missing), { ok: true, exists: false, isDirectory: false })
    assert.equal(inspectWorkspacePath('relative/path').ok, false)
    assert.equal(inspectWorkspacePath('relative/path').code, 'CWD_NOT_ABSOLUTE')
    assert.equal(inspectWorkspacePath('').code, 'CWD_MISSING')
    assert.equal(inspectWorkspacePath('foo\0bar').code, 'CWD_INVALID')
    assert.equal(inspectWorkspacePath(1).code, 'CWD_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectWorkspacePath: 指向目录的软链可用', () => {
  const { root, link } = fixture()
  try {
    assert.deepEqual(inspectWorkspacePath(link), { ok: true, exists: true, isDirectory: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assertUsableWorkspace: 只有存在的目录能建会话', () => {
  assert.deepEqual(assertUsableWorkspace({ ok: true, exists: true, isDirectory: true }), { ok: true })
  assert.equal(assertUsableWorkspace({ ok: true, exists: false, isDirectory: false }).code, 'CWD_NOT_FOUND')
  assert.equal(assertUsableWorkspace({ ok: true, exists: true, isDirectory: false }).code, 'CWD_NOT_DIRECTORY')
  assert.equal(assertUsableWorkspace({ ok: false, code: 'CWD_MISSING', error: 'x' }).code, 'CWD_MISSING')
})

test('POST /api/agos/workspace-stat: 形状与状态码', async () => {
  const { dir, missing } = fixture()
  const replies = []
  const handler = createWorkspaceStatRoute({
    sendJson: (_res, status, value) => replies.push({ status, value }),
  })[1]
  await handler({ method: 'GET' }, {})
  await handler({ method: 'POST', body: { path: dir } }, {})
  await handler({ method: 'POST', body: { path: missing } }, {})
  await handler({ method: 'POST', body: { path: 'tmp' } }, {})
  assert.equal(replies[0].status, 405)
  assert.deepEqual(replies[1], { status: 200, value: { exists: true, isDirectory: true } })
  assert.deepEqual(replies[2], { status: 200, value: { exists: false, isDirectory: false } })
  assert.equal(replies[3].status, 400)
  assert.equal(replies[3].value.code, 'CWD_NOT_ABSOLUTE')
  rmSync(dir, { recursive: true, force: true })
})
