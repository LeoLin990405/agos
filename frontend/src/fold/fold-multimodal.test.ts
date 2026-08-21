/**
 * W1 多模态归约:pickBlocks 是纯增量——非 text 块进 resultBlocks/blocks,
 * resultText 与 user text 的行为逐字节不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldJsonl } from './fold.ts'

const IMAGE_ATTACHMENT = {
  attachmentId: 'sha256:abc123',
  mediaType: 'image/png',
  bytes: 3389,
  width: 560,
  height: 180,
  name: 'shot.png',
}

test('tool/result 的 image 块进 resultBlocks,resultText 不变', () => {
  const jsonl = [
    JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp', createdAt: 1 }),
    JSON.stringify({ type: 'turn/start', time: 2, data: { turn: 1 } }),
    JSON.stringify({ type: 'tool/call', time: 3, data: { callId: 'c1', name: 'see_image', arguments: '{"image":"/tmp/a.png"}', turn: 1, step: 1 } }),
    JSON.stringify({
      type: 'tool/result', time: 4,
      data: {
        message: {
          role: 'user', id: 'm1',
          content: [{
            type: 'tool-result', toolCallId: 'c1', isError: false,
            content: [
              { type: 'image', attachment: IMAGE_ATTACHMENT },
              { type: 'text', text: '图上写着「值班表」' },
            ],
          }],
        },
      },
    }),
    JSON.stringify({ type: 'turn/end', time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')

  const folded = foldJsonl(jsonl)
  const tool = folded.items.find((i) => i.kind === 'tool')
  assert.ok(tool !== undefined && tool.kind === 'tool')
  // 不变量:resultText 与 W1 前完全一致(只拼 text 块)
  assert.equal(tool.resultText, '图上写着「值班表」')
  // 新增:image 块的引用元信息被保留
  assert.equal(tool.resultBlocks?.length, 1)
  const block = tool.resultBlocks?.[0]
  assert.equal(block?.type, 'image')
  assert.equal(block?.attachment?.attachmentId, 'sha256:abc123')
  assert.equal(block?.attachment?.mediaType, 'image/png')
  assert.equal(block?.attachment?.name, 'shot.png')
  assert.equal(block?.attachment?.width, 560)
})

test('text-only 工具结果不留 resultBlocks 字段(快照形状不变)', () => {
  const jsonl = [
    JSON.stringify({ type: 'tool/call', time: 1, data: { callId: 'c1', name: 'bash', arguments: '{}', turn: 1, step: 1 } }),
    JSON.stringify({
      type: 'tool/result', time: 2,
      data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } },
    }),
  ].join('\n')
  const folded = foldJsonl(jsonl)
  const tool = folded.items.find((i) => i.kind === 'tool')
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.resultText, 'ok')
  assert.equal(tool.resultBlocks, undefined)
  assert.equal(Object.hasOwn(tool, 'resultBlocks'), false)
})

test('user/message 的图片块进 blocks,文本不变', () => {
  const jsonl = JSON.stringify({
    type: 'user/message', time: 1,
    data: {
      id: 'u1',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: IMAGE_ATTACHMENT },
      ],
    },
  })
  const folded = foldJsonl(jsonl)
  const user = folded.items.find((i) => i.kind === 'user')
  assert.ok(user !== undefined && user.kind === 'user')
  assert.equal(user.text, '看这张图')
  assert.equal(user.blocks?.length, 1)
  assert.equal(user.blocks?.[0]?.attachment?.attachmentId, 'sha256:abc123')
})

test('path/url 形态的媒体块同样保留(不搬运二进制)', () => {
  const jsonl = [
    JSON.stringify({ type: 'tool/call', time: 1, data: { callId: 'c2', name: 'speak', arguments: '{}', turn: 1, step: 1 } }),
    JSON.stringify({
      type: 'tool/result', time: 2,
      data: {
        message: {
          role: 'user',
          content: [{
            type: 'tool-result', toolCallId: 'c2',
            content: [
              { type: 'audio', path: '/tmp/dsh-speak-x.wav', mediaType: 'audio/wav', name: 'dsh-speak-x.wav' },
              { type: 'text', text: '音频已生成: /tmp/dsh-speak-x.wav' },
            ],
          }],
        },
      },
    }),
  ].join('\n')
  const folded = foldJsonl(jsonl)
  const tool = folded.items.find((i) => i.kind === 'tool')
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.resultText, '音频已生成: /tmp/dsh-speak-x.wav')
  assert.equal(tool.resultBlocks?.[0]?.type, 'audio')
  assert.equal(tool.resultBlocks?.[0]?.path, '/tmp/dsh-speak-x.wav')
  assert.equal(tool.resultBlocks?.[0]?.mediaType, 'audio/wav')
})
