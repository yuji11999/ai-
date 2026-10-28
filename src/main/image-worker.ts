import { parentPort, isMainThread } from 'node:worker_threads';
import sharp from 'sharp';

export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export type ImageFormat = 'png' | 'jpg' | 'webp';
export interface ImageOutput { bytes: Uint8Array; thumbnail: Uint8Array; mime: string; width: number; height: number }

/** Signature checking deliberately rejects SVG/GIF/AVIF and files disguised by an extension. */
export function sniffImage(input: Uint8Array): 'png' | 'jpeg' | 'webp' {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.length < 12 || b.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 32 MB');
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('仅支持真实 PNG、JPEG 或 WebP 图片');
}

export async function processImageBuffer(input: Uint8Array, format?: ImageFormat): Promise<ImageOutput> {
  const detected = sniffImage(input);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const options = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' as const, sequentialRead: true, animated: false };
  const metadata = await sharp(bytes, options).metadata();
  if (metadata.format !== detected || !metadata.width || !metadata.height || metadata.width > 16_384 || metadata.height > 16_384 || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages ?? 1) > 1) {
    throw new Error('图片尺寸过大、包含动画或数据格式无效');
  }
  // Decode even when keeping original bytes: a plausible header is not a valid image.
  const thumbnail = await sharp(bytes, options).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  let output = bytes;
  let mime = detected === 'jpeg' ? 'image/jpeg' : `image/${detected}`;
  if (format) {
    let pipeline = sharp(bytes, options).rotate();
    if (format === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true });
    else if (format === 'png') pipeline = pipeline.png({ compressionLevel: 6 });
    else pipeline = pipeline.webp({ quality: 92 });
    output = await pipeline.toBuffer();
    if (output.length > MAX_IMAGE_BYTES) throw new Error('转换后的图片超过 32 MB');
    mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
  }
  return { bytes: output, thumbnail, mime, width: metadata.width, height: metadata.height };
}

if (!isMainThread && parentPort) {
  sharp.cache(false);
  sharp.concurrency(1);
  parentPort.once('message', async ({ bytes, format }: { bytes: Uint8Array; format?: ImageFormat }) => {
    try { parentPort!.postMessage({ ok: true, result: await processImageBuffer(bytes, format) }); }
    catch { parentPort!.postMessage({ ok: false, error: '图片无效、已损坏或超出安全尺寸限制' }); }
  });
}
