import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { FileService, type OutputContext } from '../src/main/files';
import { processImageBuffer } from '../src/main/image-worker';

// Validation artifacts are retained, including temporary hardlinks. No cleanup
// may permanently remove files under the user's recoverable-cleanup policy.
const root = path.resolve('test-results', `output-naming-${randomUUID()}`);
const originalRemove = fs.rm;
const retained = new Set<string>();
fs.rm = async target => {
  const filename = path.resolve(String(target));
  if (!filename.startsWith(root + path.sep)) throw new Error('Unexpected cleanup outside the validation directory');
  try { await fs.lstat(filename); retained.add(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
};
test.after(async () => {
  fs.rm = originalRemove;
  await fs.writeFile(path.join(root, 'validation.json'), JSON.stringify({ root, retainedTemporaryPaths: [...retained] }, null, 2));
});

async function fixture(label: string) {
  const directory = path.join(root, label, 'output');
  await fs.mkdir(directory, { recursive: true });
  const files = new FileService(path.join(root, label, 'data'), { imageProcessor: processImageBuffer });
  await files.init(); await files.registerOutputDirectory(directory);
  const png = await sharp({ create: { width: 20, height: 12, channels: 4, background: '#5b7cfa' } }).png().toBuffer();
  const context: OutputContext = { taskId: 'task-1', taskKind: 'batch', jobId: 'job-1', row: 1, run: 1, index: 1, sequence: 1, createdAt: new Date(2026, 9, 28, 12).getTime(), naming: '{序号}', namingMode: 'sequence', outputLayout: 'flat', format: 'png', outputDirectory: directory };
  const write = async (patch: Partial<OutputContext> = {}) => { const c = { ...context, ...patch }; const [source] = await files.stage([{ bytes: png }], c); return files.write(source, c); };
  return { files, directory, context, write, png };
}

test('real files use each naming preset and flat storage across tasks without overwriting', async () => {
  const { directory, write } = await fixture('flat');
  const first = await write(); assert.equal(first.name, '0001.png');
  const original = await fs.readFile(path.join(directory, first.name));
  assert.equal((await write({ taskId: 'task-2', jobId: 'job-2' })).name, '0002.png');
  assert.deepEqual(await fs.readFile(path.join(directory, first.name)), original);
  assert.equal((await write({ namingMode: 'date', jobId: 'job-date-1' })).name, '20261028.png');
  assert.equal((await write({ namingMode: 'date', jobId: 'job-date-2' })).name, '20261028_1.png');
  assert.equal((await write({ namingMode: 'date-sequence', jobId: 'job-combined' })).name, '20261028_0001.png');
  assert.equal((await write({ namingMode: 'custom', naming: '产品_{日期}_{序号}', jobId: 'job-custom' })).name, '产品_20261028_0001.png');
  assert.equal((await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).length, 0);
  assert.equal((await sharp(path.join(directory, first.name)).metadata()).format, 'png');
});

test('large existing numbering is skipped efficiently and simultaneous saves remain unique', async () => {
  const { directory, write } = await fixture('collision');
  await write();
  await fs.writeFile(path.join(directory, '40000.png'), 'existing user file');
  const results = await Promise.all([write({ jobId: 'job-2' }), write({ jobId: 'job-3' })]);
  assert.deepEqual(results.map(result => result.name).sort(), ['40001.png', '40002.png']);
  assert.equal(await fs.readFile(path.join(directory, '40000.png'), 'utf8'), 'existing user file');
});

test('a four-image row continues batch numbering and writes four distinct PNG files', async () => {
  const { files, directory, context, png } = await fixture('four-images');
  const c = { ...context, row: 2, sequence: 5 };
  const staged = await files.stage(Array.from({ length: 4 }, () => ({ bytes: png })), c);
  const results = await Promise.all(staged.map((source, index) => files.write(source, { ...c, index: index + 1 })));
  assert.deepEqual(results.map(result => result.name), ['0005.png', '0006.png', '0007.png', '0008.png']);
  for (const result of results) assert.equal((await sharp(path.join(directory, result.name)).metadata()).format, 'png');
});

test('grouped storage preserves task/run folders and old queued contexts preserve old names', async () => {
  const { directory, write } = await fixture('grouped');
  const grouped = await write({ outputLayout: 'grouped', namingMode: 'date-sequence' });
  assert.equal(grouped.name, '20261028_0001.png');
  assert.ok(await fs.stat(path.join(directory, '批量任务', 'task-1', 'run-1', grouped.name)));
  const legacy = await write({ outputLayout: undefined, namingMode: undefined, jobId: 'job-legacy' });
  assert.match(legacy.name, /_run-1_row-1_image-1\.png$/);
  assert.ok(await fs.stat(path.join(directory, '批量任务', 'task-1', 'run-1', legacy.name)));
});
