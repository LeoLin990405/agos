/**
 * W1 多模态派生 + W2 输出侧解析的组件级测试。零网络、零模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mediaFromResultBlocks, mediaFromTool, mediaKindFromPath, mediaObjectUrl, mediaRouteUrl,
} from './media-blocks.ts'
import type { ResultBlock } from '@/fold/model'

const imageBlock: ResultBlock = {
  type: 'image',
  mediaType: undefined,
  url: undefined,
  path: undefined,
  name: undefined,
  attachment: {
    attachmentId: 'sha256:abc', mediaType: 'image/png', name: 'shot.png',
    width: 560, height: 180, bytes: 3389,
  },
}

test('image 块 → attachment 引用', () => {
  const refs = mediaFromResultBlocks([imageBlock])
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.kind, 'image')
  assert.equal(refs[0]?.attachmentId, 'sha256:abc')
  assert.equal(refs[0]?.mediaType, 'image/png')
  assert.equal(refs[0]?.name, 'shot.png')
})

test('未知块类型跳过;无引用的块跳过', () => {
  const refs = mediaFromResultBlocks([
    { type: 'resource', mediaType: undefined, url: undefined, path: undefined, name: undefined, attachment: undefined },
    { type: 'image', mediaType: undefined, url: undefined, path: undefined, name: undefined, attachment: undefined },
  ])
  assert.equal(refs.length, 0)
  assert.equal(mediaFromResultBlocks(undefined).length, 0)
})

test('speak 结果文本 → 音频引用(扩展名不认则弃)', () => {
  const refs = mediaFromTool({ name: 'speak', resultText: '音频已生成: /Users/leo/.dsh/attachments/cn-media/dsh-speak-x.wav' })
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.kind, 'audio')
  assert.equal(refs[0]?.path, '/Users/leo/.dsh/attachments/cn-media/dsh-speak-x.wav')
  // 错误返回不是媒体
  assert.equal(mediaFromTool({ name: 'speak', resultText: 'TTS 后端超时' }).length, 0)
  // 无扩展名/不认的扩展名不猜
  assert.equal(mediaFromTool({ name: 'speak', resultText: '音频已生成: /tmp/noext' }).length, 0)
})

test('generate_image 结果文本 → 图片引用', () => {
  const refs = mediaFromTool({ name: 'generate_image', resultText: '图片已生成: /Users/leo/.dsh/attachments/cn-media/dsh-gen-y.png' })
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.kind, 'image')
})

test('结构化块与文本路径去重', () => {
  const block: ResultBlock = {
    type: 'audio', mediaType: 'audio/mpeg', url: undefined,
    path: '/x/dsh-speak-z.mp3', name: 'dsh-speak-z.mp3', attachment: undefined,
  }
  const refs = mediaFromTool({
    name: 'speak',
    resultText: '音频已生成: /x/dsh-speak-z.mp3',
    resultBlocks: [block],
  })
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.mediaType, 'audio/mpeg')
})

test('mediaKindFromPath 只认白名单扩展名', () => {
  assert.equal(mediaKindFromPath('/a/b.png'), 'image')
  assert.equal(mediaKindFromPath('/a/b.MP3'), 'audio')
  assert.equal(mediaKindFromPath('/a/b.txt'), undefined)
  assert.equal(mediaKindFromPath('/a/noext'), undefined)
})

test('mediaRouteUrl 编码路径', () => {
  assert.equal(mediaRouteUrl('/tmp/a b.png'), '/api/cn/media?path=%2Ftmp%2Fa%20b.png')
})

test('W19 mediaObjectUrl:只认 sha256:<64 hex>;mediaType 作期望值带上;形状不对不造 URL', () => {
  const hex = 'e384fc839166bbbd6b77c5c18e96db18d9a0eeaf88f941c24bcfaf2d8fe5efd3'
  assert.equal(mediaObjectUrl(`sha256:${hex}`, 'image/png'), `/api/cn/media?attachmentId=sha256%3A${hex}&mediaType=image%2Fpng`)
  assert.equal(mediaObjectUrl(`sha256:${hex}`), `/api/cn/media?attachmentId=sha256%3A${hex}`)
  assert.equal(mediaObjectUrl('sha256:../../etc'), undefined)
  assert.equal(mediaObjectUrl(`sha256:${hex.toUpperCase()}`), undefined)
})
