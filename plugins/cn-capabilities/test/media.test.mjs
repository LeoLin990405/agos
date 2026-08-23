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

// ───────────────────────── W19(TASK-017 第三档):v1 object store 魔数闸 ─────────────────────────
// 夹具:真实 store 形状 objects/<hex[0:2]>/<sha256 hex>,无扩展名;内容写 12 字节真 PNG 头(WEBP 判定要看到第 12 字节)。
const { objectPathForAttachmentId, isObjectStorePath, sniffMediaType } = await import('../lib/index.js')
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d', 'hex')
const HEX = 'e384fc839166bbbd6b77c5c18e96db18d9a0eeaf88f941c24bcfaf2d8fe5efd3'
const objDir = join(root, 'v1', 'objects', HEX.slice(0, 2))
mkdirSync(objDir, { recursive: true })
writeFileSync(join(objDir, HEX), PNG_HEAD)

test('W19 正向:objects 下裸 sha256 名、无扩展名 → 嗅探定 mime;attachmentId 拼路径与之同源', async () => {
  const r = await resolveMediaPath(join(objDir, HEX), rootReal)
  assert.equal(r.ok, true)
  assert.equal(r.mime, 'image/png')
  const viaId = objectPathForAttachmentId('sha256:' + HEX, root)
  assert.equal(viaId, join(root, 'v1', 'objects', HEX.slice(0, 2), HEX))
  assert.equal((await resolveMediaPath(viaId, rootReal, 'image/png')).ok, true, '期望值与嗅探一致 → 放行')
  assert.equal(objectPathForAttachmentId('sha256:../../etc/passwd', root), null)
  assert.equal(objectPathForAttachmentId('sha256:' + HEX.toUpperCase(), root), null, '只认小写 hex')
  assert.equal(objectPathForAttachmentId('md5:abc', root), null)
})

test('W19 闸 1 穿越:objects/ab/../../../outside/<hex> → outside-root(先于嗅探)', async () => {
  const outsideObj = join(outside, HEX)
  writeFileSync(outsideObj, PNG_HEAD)
  const r = await resolveMediaPath(join(objDir, '..', '..', '..', '..', 'outside', HEX), rootReal)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'outside-root')
})

test('W19 闸 2 软链:objects 下的 <hex> 是软链 → 指向根外拒(outside-root);指向根内无扩展名文件也拒(realpath 后不在 objects 下 → bad-ext)', async () => {
  const HEX2 = 'a'.repeat(64)
  const dir2 = join(root, 'v1', 'objects', 'aa'); mkdirSync(dir2, { recursive: true })
  symlinkSync(join(outside, HEX), join(dir2, HEX2))
  const r1 = await resolveMediaPath(join(dir2, HEX2), rootReal)
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'outside-root')
  const HEX3 = 'b'.repeat(64)
  const dir3 = join(root, 'v1', 'objects', 'bb'); mkdirSync(dir3, { recursive: true })
  writeFileSync(join(root, 'noext'), PNG_HEAD)
  symlinkSync(join(root, 'noext'), join(dir3, HEX3))
  const r2 = await resolveMediaPath(join(dir3, HEX3), rootReal)
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'bad-ext', '真 PNG 头也不放:嗅探只给 objects 子树下的真 object')
})

test('W19 闸 3 双扩展:objects 下带点的名字一律拒(<hex>.txt.png 即使真 PNG 头、<hex>.png.txt、<hex>.png)', async () => {
  for (const name of [HEX + '.txt.png', HEX + '.png.txt', HEX + '.png']) {
    writeFileSync(join(objDir, name), PNG_HEAD)
    const r = await resolveMediaPath(join(objDir, name), rootReal)
    assert.equal(r.ok, false, name)
    assert.equal(r.reason, 'bad-object-name', name)
  }
  // 父目录名与 hex 前两位不符也不是 store 写的
  const wrongDir = join(root, 'v1', 'objects', 'zz'); mkdirSync(wrongDir, { recursive: true })
  writeFileSync(join(wrongDir, HEX), PNG_HEAD)
  assert.equal((await resolveMediaPath(join(wrongDir, HEX), rootReal)).reason, 'bad-object-name')
  assert.equal(isObjectStorePath(join(rootReal, 'v1', 'objects', 'e3', HEX), rootReal), true)
  assert.equal(isObjectStorePath(join(rootReal, 'v1', 'objects', 'e3', HEX + '.png'), rootReal), false)
})

test('W19 闸 4 伪造 mediaType:&mediaType= 与嗅探不符 → media-type-mismatch;非图片内容 → bad-magic;目录 → not-file;白名单扩展名文件也校验期望值', async () => {
  const r1 = await resolveMediaPath(join(objDir, HEX), rootReal, 'audio/wav')
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'media-type-mismatch')
  const r1b = await resolveMediaPath(join(objDir, HEX), rootReal, 'IMAGE/PNG')
  assert.equal(r1b.ok, true, '大小写不敏感')
  const HEX4 = 'c'.repeat(64)
  const dir4 = join(root, 'v1', 'objects', 'cc'); mkdirSync(dir4, { recursive: true })
  writeFileSync(join(dir4, HEX4), 'not an image at all')
  const r2 = await resolveMediaPath(join(dir4, HEX4), rootReal)
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'bad-magic')
  const HEX5 = 'd'.repeat(64)
  const dir5 = join(root, 'v1', 'objects', 'dd'); mkdirSync(join(dir5, HEX5), { recursive: true })
  const r3 = await resolveMediaPath(join(dir5, HEX5), rootReal)
  assert.equal(r3.ok, false); assert.equal(r3.reason, 'not-file')
  const r4 = await resolveMediaPath(join(root, 'cn-media', 'a.wav'), rootReal, 'image/png')
  assert.equal(r4.ok, false); assert.equal(r4.reason, 'media-type-mismatch')
  assert.equal(sniffMediaType(Buffer.from('RIFF0000WEBP')).toString(), 'image/webp')
  assert.equal(sniffMediaType(Buffer.from('RIFF0000WEB')), null, '不足 12 字节不认 webp')
})
