import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedReferenceMarker, findMentionRange, insertReferenceMention } from './reference-mentions';

test('reference picker opens at the caret without matching emails or selected text', () => {
  assert.deepEqual(findMentionRange('使用@继续', 3, 3), { start: 2, end: 3 });
  assert.deepEqual(findMentionRange('使用@图', 4, 4), { start: 2, end: 4 });
  assert.equal(findMentionRange('cat@', 4, 4), null);
  assert.equal(findMentionRange('@图1', 3, 3), null);
  assert.equal(findMentionRange('@图', 1, 2), null);
});

test('inserts the selected image at the caret and keeps surrounding text', () => {
  const text = '把@变成水彩';
  const range = findMentionRange(text, 2, 2)!;
  assert.deepEqual(insertReferenceMention(text, range, 1), { text: '把@图2 变成水彩', caret: 5 });
  assert.deepEqual(insertReferenceMention('@ 图片', { start: 0, end: 1 }, 0), { text: '@图1 图片', caret: 4 });
});

test('removing an image cannot silently change an existing positional reference', () => {
  assert.equal(affectedReferenceMarker('使用@图2作背景', 0), '@图2');
  assert.equal(affectedReferenceMarker('使用@图二作背景', 0), '@图二');
  assert.equal(affectedReferenceMarker('使用@图1', 1), undefined);
  assert.equal(affectedReferenceMarker('邮件 user@example.com 和 @图12', 0), undefined);
});
