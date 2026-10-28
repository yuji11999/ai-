import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWindowBounds } from '../src/main/window-layout';

test('large displays start at a compact centered window', () => {
  assert.deepEqual(initialWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }), { x: 320, y: 120, width: 1280, height: 800, minWidth: 1100, minHeight: 720 });
});

test('smaller work areas keep the window and its minimum size on screen', () => {
  const medium = initialWindowBounds({ x: 0, y: 0, width: 1366, height: 728 });
  assert.deepEqual(medium, { x: 68, y: 36, width: 1229, height: 655, minWidth: 1100, minHeight: 655 });
  const small = initialWindowBounds({ x: 10, y: 20, width: 1024, height: 600 });
  assert.deepEqual(small, { x: 61, y: 50, width: 921, height: 540, minWidth: 921, minHeight: 540 });
});

test('positions are centered within a secondary display work area', () => {
  const area = { x: -1920, y: 40, width: 1920, height: 1040 };
  assert.deepEqual(initialWindowBounds(area), { x: -1600, y: 160, width: 1280, height: 800, minWidth: 1100, minHeight: 720 });
});
