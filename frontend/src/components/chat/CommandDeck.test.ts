import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommandDeckMessage,
  extractMultimodalMessageId,
  remainingDraftAfterSend,
  stripMultimodalMessageMarker,
} from './CommandDeck';
import { createImageAttachmentSnapshot, type ImageAttachmentDraft } from './ImageAttachments';

const image: ImageAttachmentDraft = {
  id: 'img-1',
  name: 'screen.png',
  mediaType: 'image/png',
  bytes: 3,
  data: 'AQID',
  previewUrl: 'data:image/png;base64,AQID',
};

test('multimodal message persists a fold placeholder and keeps native image parts', () => {
  const message = buildCommandDeckMessage('检查截图', createImageAttachmentSnapshot([image]));
  assert.ok(message);
  assert.match(message.text, /^检查截图\n\n\[图片 ×1\]\n<!-- agos-image:[^ ]+ -->$/);
  assert.deepEqual(message.parts.slice(1), [
    { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'screen.png' },
  ]);
  assert.equal(message.parts[0]?.type, 'text');
  assert.equal(message.parts[0]?.type === 'text' ? message.parts[0].text : '', message.text);
  assert.ok(message.optimisticId);
  assert.equal(extractMultimodalMessageId(message.text), message.optimisticId);
  assert.equal(stripMultimodalMessageMarker(message.text), '检查截图\n\n[图片 ×1]');
  assert.equal(message.images[0]?.url, image.previewUrl);
});

test('image-only messages receive distinct reconciliation ids', () => {
  const first = buildCommandDeckMessage('', createImageAttachmentSnapshot([image]));
  const second = buildCommandDeckMessage('', createImageAttachmentSnapshot([image]));
  assert.ok(first?.optimisticId);
  assert.ok(second?.optimisticId);
  assert.notEqual(first.optimisticId, second.optimisticId);
  assert.equal(extractMultimodalMessageId(first.text), first.optimisticId);
  assert.equal(extractMultimodalMessageId(second.text), second.optimisticId);
});

test('a transcript arriving during send remains in the composer', () => {
  assert.equal(remainingDraftAfterSend('旧草稿', '旧草稿'), '');
  assert.equal(remainingDraftAfterSend('旧草稿 新转写', '旧草稿'), '新转写');
  assert.equal(remainingDraftAfterSend('旧草稿 新转写', '旧草稿  '), '新转写');
  assert.equal(remainingDraftAfterSend('用户另改的内容', '旧草稿'), '用户另改的内容');
});

test('empty composer stays inert while text-only behavior remains one text part', () => {
  assert.equal(buildCommandDeckMessage('  ', createImageAttachmentSnapshot([])), null);
  assert.deepEqual(
    buildCommandDeckMessage(' 普通消息 ', createImageAttachmentSnapshot([]))?.parts,
    [{ type: 'text', text: '普通消息' }],
  );
});
