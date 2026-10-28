import test from 'node:test';
import assert from 'node:assert/strict';
import { enabledOptionIndex, matchingOptionIndex, selectMenuPosition, type SelectOption } from './select-utils';

const options: SelectOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'square', label: '1:1', disabled: true },
  { value: 'portrait', label: '2:3' },
  { value: 'landscape', label: '16:9' },
];

test('keyboard navigation skips disabled options and stops at list boundaries', () => {
  assert.equal(enabledOptionIndex(options, 1, 1), 2);
  assert.equal(enabledOptionIndex(options, 1, -1), 0);
  assert.equal(enabledOptionIndex(options, options.length, 1), -1);
  assert.equal(enabledOptionIndex([{ value: 'x', label: '不可选', disabled: true }], 0, 1), -1);
});

test('type-ahead finds enabled items and cycles through matching labels', () => {
  assert.equal(matchingOptionIndex(options, '1', 0), 3);
  assert.equal(matchingOptionIndex(options, '自', 3), 0);
  assert.equal(matchingOptionIndex(options, '不存在', 0), -1);
  const models: SelectOption[] = [{ value: 'a', label: 'GPT A' }, { value: 'b', label: 'gpt B' }];
  assert.equal(matchingOptionIndex(models, 'gPt', 0), 1);
  assert.equal(matchingOptionIndex(models, 'gpt', 1), 0);
});

test('menu opens toward available space and stays inside the window', () => {
  const below = selectMenuPosition({ left: 20, top: 40, bottom: 74, width: 120 }, { width: 800, height: 600 }, 4, 180);
  assert.equal(below.top, 80); assert.equal(below.width, 180);
  const above = selectMenuPosition({ left: 760, top: 540, bottom: 574, width: 120 }, { width: 800, height: 600 }, 8, 180);
  assert.equal(above.top + above.maxHeight, 534);
  assert.ok(above.left + above.width <= 792);
  const narrow = selectMenuPosition({ left: 0, top: 30, bottom: 60, width: 80 }, { width: 120, height: 160 }, 8, 180);
  assert.ok(narrow.width <= 104); assert.ok(narrow.top >= 8); assert.ok(narrow.top + narrow.maxHeight <= 152);
});

test('upward menus align with the trigger when options wrap', () => {
  const rect = { left: 20, top: 340, bottom: 374, width: 120 };
  const wrapped = selectMenuPosition(rect, { width: 500, height: 400 }, 3, 180, 170);
  assert.equal(wrapped.maxHeight, 170);
  assert.equal(wrapped.top + wrapped.maxHeight, rect.top - 6);
  const longList = selectMenuPosition(rect, { width: 500, height: 400 }, 3, 180, 450);
  assert.equal(longList.maxHeight, 280);
  assert.equal(longList.top + longList.maxHeight, rect.top - 6);
});
