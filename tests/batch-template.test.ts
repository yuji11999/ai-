import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import { BATCH_TEMPLATE_EXAMPLE, createBatchTemplate, FileService, parseXlsxRows } from '../src/main/files';

test('downloadable template contains a header and exactly one importable example', async () => {
  const bytes = await createBatchTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A1').value, '提示词');
  assert.equal(sheet.getCell('A2').value, BATCH_TEMPLATE_EXAMPLE);
  assert.deepEqual(await parseXlsxRows(bytes), [BATCH_TEMPLATE_EXAMPLE]);
});

test('Excel imports use the first column, preserve duplicates and reject formulas', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('提示词');
  sheet.addRows([['提示词', '忽略'], ['猫', 'ignored'], [], ['猫'], ['狗']]);
  workbook.addWorksheet('另一个工作表').addRow(['不读取']);
  assert.deepEqual(await parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), ['猫', '猫', '狗']);
  sheet.getCell('A3').value = { formula: '1+1', result: 2 };
  await assert.rejects(parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), /包含公式/);
  await assert.rejects(parseXlsxRows(Buffer.alloc(20 * 1024 * 1024 + 1)), /大小限制/);
});

test('text files are rejected before reading', async () => {
  const files = new FileService(path.resolve('unused'));
  await assert.rejects(files.importRows('prompts.txt'), /仅支持 XLSX/);
  await assert.rejects(files.importRows('prompts.csv'), /仅支持 XLSX/);
});

test('saving a template never overwrites an existing file', async t => {
  const destination = path.resolve('already-exists.xlsx');
  const realpath = t.mock.method(fs, 'realpath', (async () => path.dirname(destination)) as unknown as typeof fs.realpath);
  const open = t.mock.method(fs, 'open', (async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }) as typeof fs.open);
  const files = new FileService(path.resolve('unused'));
  await assert.rejects(files.exportBatchTemplate(destination), /文件已存在/);
  assert.equal(realpath.mock.calls.length, 1);
  assert.equal(open.mock.calls[0].arguments[1], 'wx');
});

test('saving a new template writes a readable workbook to the selected path', async t => {
  const destination = path.resolve('new-template.xlsx');
  let bytes = Buffer.alloc(0), synced = false, closed = false;
  t.mock.method(fs, 'realpath', (async () => path.dirname(destination)) as unknown as typeof fs.realpath);
  const open = t.mock.method(fs, 'open', (async () => ({
    async writeFile(value: Uint8Array) { bytes = Buffer.from(value); },
    async sync() { synced = true; },
    async close() { closed = true; },
  })) as unknown as typeof fs.open);
  await new FileService(path.resolve('unused')).exportBatchTemplate(destination);
  assert.equal(open.mock.calls[0].arguments[1], 'wx');
  assert.ok(synced && closed);
  assert.deepEqual(await parseXlsxRows(bytes), [BATCH_TEMPLATE_EXAMPLE]);
});
