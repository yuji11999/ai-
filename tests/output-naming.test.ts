import test from 'node:test';
import assert from 'node:assert/strict';
import { namingModeForTemplate, outputName, presetNamingMode } from '../src/shared/output-naming';

const context = { naming: '{序号}_{日期}', sequence: 5, row: 2, index: 1, run: 3, createdAt: new Date(2026, 9, 28, 12).getTime() };
test('preset names use the selected order and enumerate all images of a batch', () => {
  assert.equal(outputName({ ...context, namingMode: 'sequence' }).base, '0005');
  assert.equal(outputName({ ...context, namingMode: 'sequence', index: 4 }).base, '0008');
  assert.equal(outputName({ ...context, namingMode: 'date' }).base, '20261028');
  assert.equal(outputName({ ...context, namingMode: 'date-sequence' }).base, '20261028_0005');
  assert.equal(outputName({ ...context, namingMode: 'custom', naming: '产品_{日期}_{序号}' }).base, '产品_20261028_0005');
});
test('collision names advance sequential presets without changing legacy queued contexts', () => {
  assert.equal(outputName({ ...context, namingMode: 'sequence' }, 6).base, '0011');
  assert.equal(outputName({ ...context, namingMode: 'date' }, 1).base, '20261028_1');
  assert.equal(outputName(context).base, '0002-01_20261028_run-3_row-2_image-1');
  assert.equal(namingModeForTemplate('{日期}_{序号}'), 'date-sequence');
  assert.equal(namingModeForTemplate('{序号}_{日期}'), 'custom');
  assert.equal(presetNamingMode('custom', '旧_{序号}'), 'date-sequence');
  assert.equal(presetNamingMode(undefined, '{序号}'), 'sequence');
});
