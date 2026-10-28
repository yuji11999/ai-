import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FileService } from '../src/main/files';
import { processImageBuffer, sniffImage } from '../src/main/image-worker';

test('reference preview and export use the original asset without overwriting files', async t => {
  const original = await sharp({ create: { width: 48, height: 24, channels: 3, background: '#5588aa' } }).png().toBuffer();
  const jpeg = await sharp(original).jpeg().toBuffer(), webp = await sharp(original).webp().toBuffer();
  const files = new FileService(path.resolve('reference-preview-test'), { imageProcessor: processImageBuffer });
  const assets = (files as unknown as { assets: Map<string, unknown> }).assets;
  assets.set('reference-1', { id: 'reference-1', kind: 'reference', name: 'original.png', file: 'reference-1.bin', thumbnail: 'reference-1-thumb.webp', mime: 'image/png', size: original.length });
  assets.set('reference-jpeg', { id: 'reference-jpeg', kind: 'reference', name: 'original.jpg', file: 'reference-jpeg.bin', mime: 'image/jpeg', size: jpeg.length });
  assets.set('reference-webp', { id: 'reference-webp', kind: 'reference', name: 'original.webp', file: 'reference-webp.bin', mime: 'image/webp', size: webp.length });
  assets.set('result-1', { id: 'result-1', kind: 'result', name: 'result.png', file: 'result-1.png', mime: 'image/png', size: original.length });
  assert.equal(files.resolveFullReference('reference-1')?.mimeType, 'image/png');
  assert.match(files.resolveFullReference('reference-1')!.path, /reference-1\.bin$/);
  assert.equal(files.resolveFullReference('result-1'), undefined);
  assert.equal(files.resolveFullReference('../reference-1'), undefined);

  const outputs = new Map<string, Buffer>();
  t.mock.method(fs, 'realpath', (async (directory: string) => directory) as unknown as typeof fs.realpath);
  t.mock.method(fs, 'open', (async (filename: string, flags: string | number) => {
    if (flags === 'wx') {
      if (outputs.has(filename)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      return { writeFile: async (bytes: Uint8Array) => { outputs.set(filename, Buffer.from(bytes)); }, sync: async () => {}, close: async () => {} };
    }
    const input = filename.endsWith('reference-jpeg.bin') ? jpeg : filename.endsWith('reference-webp.bin') ? webp : original;
    let offset = 0;
    return { stat: async () => ({ isFile: () => true, size: input.length }), read: async (buffer: Buffer, start: number, length: number) => { const count = Math.min(length, input.length - offset); input.copy(buffer, start, offset, offset + count); offset += count; return { bytesRead: count, buffer }; }, close: async () => {} };
  }) as unknown as typeof fs.open);

  const png = await files.referenceAsPng('reference-1');
  assert.equal(sniffImage(png), 'png');
  const target = path.resolve('reference-preview-test', 'saved.png');
  await files.exportReference('reference-1', target);
  assert.deepEqual(outputs.get(target), original);
  await assert.rejects(files.exportReference('reference-1', target), /文件已存在/);
  assert.deepEqual(outputs.get(target), original);
  await assert.rejects(files.exportReference('reference-1', path.resolve('reference-preview-test', 'wrong.jpg')), /扩展名/);
  await assert.rejects(files.referenceAsPng('result-1'), /图片不存在/);
  for (const [id, extension, bytes] of [['reference-jpeg', 'jpg', jpeg], ['reference-webp', 'webp', webp]] as const) {
    assert.equal(sniffImage(await files.referenceAsPng(id)), 'png');
    const destination = path.resolve('reference-preview-test', `${id}.${extension}`);
    await files.exportReference(id, destination);
    assert.deepEqual(outputs.get(destination), bytes);
  }
});
