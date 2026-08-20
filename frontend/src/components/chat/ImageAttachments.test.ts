import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPromptParts,
  IMAGE_ATTACHMENT_MAX_BYTES,
  imageFileToAttachment,
  prepareImageFiles,
} from './ImageAttachments.tsx';

test('imageFileToAttachment emits raw base64 and a bounded fallback preview without DOM canvas', async () => {
  const file = new File([new Uint8Array([0, 1, 2, 255])], 'sample.png', { type: 'image/png' });
  const image = await imageFileToAttachment(file);

  assert.equal(image.data, 'AAEC/w==');
  assert.equal(image.data.startsWith('data:'), false);
  assert.match(image.previewUrl, /^data:image\/svg\+xml,/);
  assert.equal(image.previewUrl.includes(image.data), false);
  assert.equal(image.mediaType, 'image/png');
});

test('prepareImageFiles enforces contract media types, 5 MB, and a four-image queue', async () => {
  const valid = new File(['ok'], 'ok.webp', { type: 'image/webp' });
  const unsupported = new File(['no'], 'no.svg', { type: 'image/svg+xml' });
  const oversized = new File([new Uint8Array(IMAGE_ATTACHMENT_MAX_BYTES + 1)], 'large.gif', { type: 'image/gif' });
  const result = await prepareImageFiles([valid, unsupported, oversized, valid], 3);

  assert.equal(result.attachments.length, 1);
  assert.equal(result.errors.some((message) => message.includes('仅支持')), true);
  assert.equal(result.errors.some((message) => message.includes('5 MB')), true);
  assert.equal(result.errors.some((message) => message.includes('最多可添加 4 张')), true);
});

test('buildPromptParts preserves text and maps queue items to contract image parts', async () => {
  const image = await imageFileToAttachment(new File(['pixel'], 'pixel.jpg', { type: 'image/jpeg' }));
  const parts = buildPromptParts('inspect this', [image]);

  assert.deepEqual(parts, [
    { type: 'text', text: 'inspect this' },
    { type: 'image', mediaType: 'image/jpeg', data: image.data, name: 'pixel.jpg' },
  ]);
});
