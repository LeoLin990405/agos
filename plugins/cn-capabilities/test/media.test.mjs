// /api/cn/media 路径闸的离线测试(零网络、零模型):
//   ① realpath 后必须在附件根之下(含软链绕行)② 扩展名白名单 ③ 缺失即 404 语义
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { resolveMediaPath } = await import('../lib/index.js')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-cn-media-gate-'))
const root = join(tmp, 'attachments')
const outside = join(tmp, 'outside')
mkdirSync(join(root, 'cn-media'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(root, 'cn-media', 'a.wav'), 'RIFF....')
writeFileSync(join(root, 'b.txt'), 'nope')
writeFileSync(join(outside, 'secret.png'), 'PNG')
symlinkSync(join(outside, 'secret.png'), join(root, 'cn-media', 'escape.png'))
const rootReal = await realpath(root)

test('根内允许的文件通过,带出 mime', async () => {
  const r = await resolveMediaPath(join(root, 'cn-media', 'a.wav'), rootReal)
  assert.equal(r.ok, true)
  assert.equal(r.mime, 'audio/wav')
  assert.ok(r.real.endsWith('a.wav'))
})

test('../ 逃逸被拒(outside-root)', async () => {
  const r = await resolveMediaPath(join(root, '..', 'outside', 'secret.png'), rootReal)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'outside-root')
})

test('软链绕行被拒(指向根外的符号链接 realpath 后出界)', async () => {
  const r = await resolveMediaPath(join(root, 'cn-media', 'escape.png'), rootReal)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'outside-root')
})

test('扩展名白名单:.txt 即使在根内也拒', async () => {
  const r = await resolveMediaPath(join(root, 'b.txt'), rootReal)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-ext')
})

test('不存在的文件 → not-found;空路径 → missing', async () => {
  assert.equal((await resolveMediaPath(join(root, 'cn-media', 'ghost.mp3'), rootReal)).reason, 'not-found')
  assert.equal((await resolveMediaPath('', rootReal)).reason, 'missing')
})

test('大小写不敏感:.PNG 视作图片', async () => {
  writeFileSync(join(root, 'cn-media', 'c.PNG'), 'PNG')
  const r = await resolveMediaPath(join(root, 'cn-media', 'c.PNG'), rootReal)
  assert.equal(r.ok, true)
  assert.equal(r.mime, 'image/png')
})

test('附件根本身不作为文件通过(无扩展名)', async () => {
  const r = await resolveMediaPath(root, rootReal)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-ext')
})

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
