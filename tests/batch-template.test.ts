import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import { BATCH_TEMPLATE_EXAMPLE, createBatchTemplate, FileService, parseXlsxRows } from '../src/main/files';
import { importBatchReferences } from '../src/main/batch-import';

test('downloadable template contains a header and exactly one importable example', async () => {
  const bytes = await createBatchTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A1').value, '提示词');
  assert.equal(sheet.getCell('A2').value, BATCH_TEMPLATE_EXAMPLE);
  assert.equal(sheet.getCell('B1').value, '参考图路径（可选）');
  assert.equal(sheet.getCell('B2').value, 'D:\\图片\\参考图.png');
  assert.deepEqual(await parseXlsxRows(bytes), [{ prompt: BATCH_TEMPLATE_EXAMPLE, referencePath: 'D:\\图片\\参考图.png', sourceRow: 2 }]);
});

test('Excel imports preserve row reference paths, hyperlinks and duplicate prompts', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('提示词');
  const image = path.resolve('images', '猫 图.png');
  const link = pathToFileURL(image).href;
  sheet.addRows([['提示词', '参考图路径'], ['猫', image], [], ['猫', { text: '点击查看', hyperlink: link }], ['狗']]);
  workbook.addWorksheet('另一个工作表').addRow(['不读取']);
  assert.deepEqual(await parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), [{ prompt: '猫', referencePath: image, sourceRow: 2 }, { prompt: '猫', referencePath: link, sourceRow: 4 }, { prompt: '狗', referencePath: '', sourceRow: 5 }]);
  sheet.getCell('A3').value = { formula: '1+1', result: 2 };
  await assert.rejects(parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), /包含公式/);
  sheet.getCell('A3').value = null;
  sheet.getCell('B3').value = { formula: '"bad"', result: 'bad' };
  await assert.rejects(parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), /第 3 行包含公式/);
  sheet.getCell('B3').value = 'missing-prompt.png';
  await assert.rejects(parseXlsxRows(Buffer.from(await workbook.xlsx.writeBuffer())), /第 3 行缺少提示词/);
  await assert.rejects(parseXlsxRows(Buffer.alloc(20 * 1024 * 1024 + 1)), /大小限制/);
});

test('batch references resolve local file links, reuse duplicates and validate before import', async () => {
  const workbook = path.resolve('表格', '任务.xlsx');
  const image = path.resolve('表格', '参考 图.png');
  const rows = [{ prompt: '第一行', referencePath: '参考 图.png', sourceRow: 2 }, { prompt: '第二行', referencePath: pathToFileURL(image).href, sourceRow: 3 }, { prompt: '第三行', referencePath: '', sourceRow: 4 }];
  const importedPaths: string[] = [];
  const refs = await importBatchReferences(rows, workbook, {
    stat: async () => ({ isFile: () => true, size: 100 }),
    importReferences: async paths => { importedPaths.push(...paths); return [{ id: 'img', name: '参考 图.png', url: 'qingtu-asset://img' }]; },
  });
  assert.deepEqual(importedPaths, [image]);
  assert.deepEqual(refs.map(ref => ref?.id ?? null), ['img', 'img', null]);
  let imports = 0;
  await assert.rejects(importBatchReferences([{ prompt: '错误', referencePath: 'https://example.com/image.png', sourceRow: 8 }], workbook, { importReferences: async () => { imports++; return []; } }), /第 8 行/);
  await assert.rejects(importBatchReferences([{ prompt: '错误', referencePath: 'missing.png', sourceRow: 9 }], workbook, { stat: async () => { throw new Error('missing'); }, importReferences: async () => { imports++; return []; } }), /第 9 行/);
  assert.equal(imports, 0);
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
  assert.deepEqual((await parseXlsxRows(bytes)).map(row => row.prompt), [BATCH_TEMPLATE_EXAMPLE]);
});
