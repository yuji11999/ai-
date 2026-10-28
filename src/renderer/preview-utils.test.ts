import test from 'node:test';
import assert from 'node:assert/strict';
import { movePreview, selectPreview, type PreviewImage } from './preview-utils';

test('preview navigation starts at the clicked image and stops at both ends', () => {
  const images: PreviewImage[] = [
    { kind: 'result', id: 'one', name: '第一张' },
    { kind: 'result', id: 'two', name: '第二张' },
    { kind: 'result', id: 'three', name: '第三张' },
  ];
  const selected = selectPreview(images, images[1])!;
  assert.equal(selected.index, 1);
  assert.equal(movePreview(selected, -1).index, 0);
  assert.equal(movePreview(selected, 1).index, 2);
  assert.equal(movePreview(movePreview(selected, -1), -1).index, 0);
  assert.equal(movePreview(movePreview(selected, 1), 1).index, 2);
  assert.equal(selectPreview(images, { kind: 'reference', id: 'two', name: '不匹配' }), null);
});

test('a single image remains selected when navigation is requested', () => {
  const image: PreviewImage = { kind: 'reference', id: 'ref', name: '参考图' };
  const selected = selectPreview([image], image)!;
  assert.equal(movePreview(selected, -1), selected);
  assert.equal(movePreview(selected, 1), selected);
});
