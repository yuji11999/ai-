import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import type { Reference, ResultImage } from '../shared/types';
import type { ImageFormat, ImageOutput } from './image-worker';

export function localDateStamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('任务时间无效');
  return `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
}

const MB = 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * MB;
const MAX_ROWS = 10_000;
const MAX_REFERENCE_BYTES = 20 * MB;
const MAX_REFERENCE_TOTAL = 100 * MB;
const MAX_DOWNLOAD_BYTES = 32 * MB;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MANIFEST_NAME = 'assets.json';

export interface ProviderImage { bytes?: Uint8Array; url?: string; mime?: string }
export interface StoredImage { id: string; url?: string; path?: string; mime?: string }
export interface OutputContext { taskId: string; taskKind: 'single' | 'batch'; jobId: string; run: number; row: number; index: number; outputDirectory: string; naming: string; format: ImageFormat; createdAt: number }
interface AssetRecord {
  id: string; kind: 'reference' | 'result'; name: string; file?: string; thumbnail?: string; mime?: string;
  size: number; sourceURL?: string; outputPath?: string; context?: OutputContext; stageCount?: number;
}
interface Manifest { version: 1 | 2; assets?: AssetRecord[]; directories: string[] }
export interface FileServiceOptions {
  workerPath?: string;
  imageProcessor?: (bytes: Uint8Array, format?: ImageFormat) => Promise<ImageOutput>;
  download?: (url: string) => Promise<Uint8Array>;
  link?: typeof fs.link;
}
function fail(message: string): never { throw new Error(message); }
function validId(value: string): string { if (typeof value !== 'string' || !ID.test(value)) fail('无效的文件标识'); return value; }
function assetURL(id: string): string { return `qingtu-asset://asset/${validId(id)}`; }
function safeBasename(value: string): string {
  return path.basename(value).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || '图片';
}
function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); }
async function readBounded(filename: string, maximum: number): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) fail(`文件无效或超过 ${maximum / MB} MB`);
    // The limit remains effective if a selected local file grows after stat().
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; if (total > maximum) fail('文件超过大小限制'); chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

/** Preflight every entry before ExcelJS/JSZip can inflate it. ZIP64, encrypted and overlapping records are unsupported. */
export function validateXlsxArchive(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) fail('无效的 XLSX 文件');
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { eocd = p; break; }
  }
  if (eocd < 0) fail('XLSX 压缩目录无效');
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6) || bytes.readUInt16LE(eocd + 8) !== count || count === 0 || count > 5000 || centralOffset + centralSize !== eocd || centralOffset === 0xffffffff) fail('XLSX 压缩包结构或条目数超出限制');
  let p = centralOffset, total = 0;
  const names = new Set<string>(); const ranges: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || bytes.readUInt32LE(p) !== 0x02014b50) fail('XLSX 压缩目录损坏');
    const flags = bytes.readUInt16LE(p + 8), method = bytes.readUInt16LE(p + 10), compressed = bytes.readUInt32LE(p + 20), uncompressed = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28), extraLength = bytes.readUInt16LE(p + 30), commentLength = bytes.readUInt16LE(p + 32), local = bytes.readUInt32LE(p + 42);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || !nameLength || flags & 1 || ![0, 8].includes(method) || uncompressed > 32 * MB || compressed > MAX_IMPORT_BYTES || total + uncompressed > 100 * MB) fail('XLSX 解压大小超过安全限制');
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLength);
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || name.includes('\0') || names.has(name)) fail('XLSX 压缩条目名称无效');
    names.add(name);
    if (/vbaProject|embeddings\/|\.bin$/i.test(name)) fail('不支持含宏或嵌入附件的工作簿');
    if (local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50) fail('XLSX 文件条目无效');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtra;
    if (start + compressed > centralOffset || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags || bytes.toString('utf8', local + 30, local + 30 + localNameLength) !== name) fail('XLSX 文件条目不一致');
    ranges.push([local, start + compressed]);
    let inflated: Buffer;
    try { inflated = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, uncompressed) }); }
    catch { return fail('XLSX 解压失败或超过安全限制'); }
    if (inflated.length !== uncompressed) fail('XLSX 解压大小不一致');
    total += inflated.length;
    if (name.endsWith('.xml')) {
      const xml = inflated.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XLSX 不支持外部实体');
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        if ((xml.match(/<row(?:\s|>)/g)?.length ?? 0) > MAX_ROWS + 1 || (xml.match(/<c(?:\s|>)/g)?.length ?? 0) > 100_000) fail('工作表行数或单元格数量超过安全限制');
      }
    }
    p = end;
  }
  if (p !== eocd || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) fail('不是有效的 XLSX 工作簿');
  ranges.sort((a,b) => a[0]-b[0]);
  for (let n = 1; n < ranges.length; n++) if (ranges[n][0] < ranges[n-1][1]) fail('XLSX 压缩条目重叠');
}

export const BATCH_TEMPLATE_EXAMPLE = '一只戴着围巾的橘猫坐在窗边，柔和的自然光，细节清晰';
export async function createBatchTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('批量提示词', { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = [{ width: 76 }];
  worksheet.addRow(['提示词']);
  worksheet.addRow([BATCH_TEMPLATE_EXAMPLE]);
  worksheet.getRow(1).height = 25;
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF415CB6' } };
  worksheet.getRow(1).alignment = { vertical: 'middle' };
  worksheet.getRow(2).height = 34;
  worksheet.getRow(2).alignment = { vertical: 'middle', wrapText: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function parseXlsxRows(bytes: Buffer): Promise<string[]> {
  if (bytes.length > MAX_IMPORT_BYTES) fail('文件超过大小限制');
  validateXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as any, { ignoreNodes: ['drawing','extLst','picture'] }); } catch { return fail('无法读取 XLSX 工作簿'); }
  const worksheet = workbook.worksheets[0]; if (!worksheet) fail('工作簿没有工作表');
  const rows: string[] = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    const cell = row.getCell(1), value = cell.value;
    if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) fail('首列包含公式，请先粘贴为纯文本再导入');
    const text = cell.text.trim(); if (text) rows.push(text);
    if (rows.length > MAX_ROWS + 1) fail('最多导入 10000 行提示词');
  });
  if (rows[0] === '提示词' || rows[0]?.toLowerCase() === 'prompt') rows.shift();
  if (rows.length > MAX_ROWS) fail('最多导入 10000 行提示词');
  if (!rows.length) fail('没有可导入的提示词');
  return rows;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  // Only native global unicast is permitted. This also rejects IPv4-mapped, NAT64 and local addresses.
  const first = parseInt(lower.split(':')[0], 16), second = parseInt(lower.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8));
}
export function validateDownloadURL(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 16_384) fail('图片下载地址无效');
  let url: URL; try { url = new URL(raw); } catch { return fail('图片下载地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hash) fail('图片仅允许无凭证的 HTTPS 下载地址');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && !isPublicAddress(host))) fail('禁止下载本机或内网图片地址');
  return url;
}
export interface DownloadDependencies { lookup?: typeof dnsLookup; request?: typeof httpsRequest }
export async function downloadImage(raw: string, deps: DownloadDependencies = {}): Promise<Buffer> {
  const url = validateDownloadURL(raw), host = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer: NodeJS.Timeout | undefined;
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      (deps.lookup ?? dnsLookup)(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('图片地址解析超时')), 5000); }),
    ]);
  } catch { return fail('图片地址解析失败或超时'); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) fail('图片下载地址解析到禁止访问的网络');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    let settled = false; let timer: NodeJS.Timeout;
    const done = (error?: Error, bytes?: Buffer) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(bytes!); };
    // An isolated agent plus a pinned lookup prevents DNS rebinding and never carries provider credentials.
    const req = (deps.request ?? httpsRequest)(url, {
      method: 'GET', agent: false, maxHeaderSize: 16 * 1024,
      headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' },
      lookup: ((_hostname: string, options: any, callback: any) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as any,
    }, response => {
      if (response.statusCode !== 200) { response.resume(); done(new Error(response.statusCode && response.statusCode >= 300 && response.statusCode < 400 ? '图片下载不允许重定向' : '图片下载失败，可单独重试保存')); req.destroy(); return; }
      const length = Number(response.headers['content-length']);
      if ((Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { response.destroy(); done(new Error('图片下载超过限制或使用不支持的压缩')); return; }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > MAX_DOWNLOAD_BYTES) { done(new Error('图片下载超过 32 MB')); response.destroy(); req.destroy(); } else chunks.push(chunk); });
      response.on('end', () => done(undefined, Buffer.concat(chunks, total)));
      response.on('error', () => done(new Error('图片下载中断，可单独重试保存')));
      response.on('aborted', () => done(new Error('图片下载中断，可单独重试保存')));
    });
    timer = setTimeout(() => { done(new Error('图片下载超时，可单独重试保存')); req.destroy(); }, 30_000);
    req.on('error', () => done(new Error('图片下载失败，可单独重试保存')));
    req.end();
  });
}

export function validateNaming(naming: string): string {
  if (typeof naming !== 'string' || !naming.trim() || naming.length > 100 || /[\x00-\x1f<>:"/\\|?*]/.test(naming)) fail('命名模板无效');
  const remaining = naming.replace(/\{序号\}|\{日期\}/g, '');
  if (/[{}]/.test(remaining) || /[. ]$/.test(naming)) fail('命名仅支持 {序号} 和 {日期}');
  return naming;
}
function validateContext(context: OutputContext): void {
  validId(context.taskId); validId(context.jobId); validateNaming(context.naming);
  if (!['png','jpg','webp'].includes(context.format) || !['single','batch'].includes(context.taskKind) || (!Number.isSafeInteger(context.createdAt) || context.createdAt < 0 || context.createdAt > 8_640_000_000_000_000) || ![context.row,context.run,context.index].every(x => Number.isSafeInteger(x) && x > 0 && x <= 100_000_000)) fail('图片输出参数无效');
}

export class FileService {
  private readonly root: string;
  private readonly assets = new Map<string, AssetRecord>();
  private readonly groups = new Map<string, Set<string>>();
  private readonly directories = new Set<string>();
  private manifestQueue: Promise<void> = Promise.resolve();
  private referenceQueue: Promise<unknown> = Promise.resolve();
  private imageQueue: Promise<unknown> = Promise.resolve();
  private readonly writes = new Map<string, Promise<ResultImage>>();
  constructor(dataDirectory: string, private readonly options: FileServiceOptions = {}) { this.root = path.resolve(dataDirectory, 'assets'); }
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, 'metadata'), { recursive: true, mode: 0o700 });
    try {
      let manifest: Manifest; let fresh = false;
      try { manifest = JSON.parse((await readBounded(path.join(this.root, MANIFEST_NAME), 256 * MB)).toString('utf8')); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        fresh = true; manifest = { version: 2, directories: [] };
      }
      if (![1,2].includes(manifest.version) || !Array.isArray(manifest.directories)) fail('图片索引格式无效');
      for (const directory of manifest.directories) if (typeof directory === 'string' && path.isAbsolute(directory)) this.directories.add(path.resolve(directory));
      const accept = (asset: AssetRecord) => {
        validId(asset.id);
        if (!['reference','result'].includes(asset.kind) || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.size) || asset.size < 0) fail('图片索引内容无效');
        if (asset.file) this.managedPath(asset.file);
        if (asset.thumbnail) this.managedPath(asset.thumbnail);
        if (asset.sourceURL) validateDownloadURL(asset.sourceURL);
        if (asset.context) validateContext(asset.context);
        if (asset.outputPath && ![...this.directories].some(root => inside(root, path.resolve(asset.outputPath!)))) fail('图片输出索引无效');
        this.putAsset(asset);
      };
      if (manifest.version === 1) {
        if (!Array.isArray(manifest.assets)) fail('图片索引格式无效');
        manifest.assets.forEach(accept);
        await this.persist([...this.assets.values()]);
      } else {
        for (const filename of await fs.readdir(path.join(this.root, 'metadata'))) {
          if (!/^(reference|result)-[a-zA-Z0-9_-]+\.json$/.test(filename)) continue;
          const shard = JSON.parse((await readBounded(path.join(this.root, 'metadata', filename), MB)).toString('utf8'));
          if (!Array.isArray(shard) || shard.length < 1 || shard.length > 16) fail('图片分片索引无效');
          for (const asset of shard) {
            if (`${this.groupKey(asset)}.json` !== filename) fail('图片分片索引不匹配');
            accept(asset);
          }
        }
      }
      if (fresh) await this.persist();
    } catch { throw new Error('无法读取图片索引，请勿删除原始文件'); }
  }
  private groupKey(asset: AssetRecord): string { return `${asset.kind}-${validId(asset.kind === 'result' ? asset.context?.jobId ?? '' : asset.id)}`; }
  private putAsset(asset: AssetRecord): void {
    this.assets.set(asset.id, asset);
    const key = this.groupKey(asset), group = this.groups.get(key) ?? new Set<string>();
    group.add(asset.id); this.groups.set(key, group);
  }
  private deleteAsset(asset: AssetRecord): void { this.assets.delete(asset.id); this.groups.get(this.groupKey(asset))?.delete(asset.id); }
  private managedPath(filename: string): string {
    if (typeof filename !== 'string' || path.basename(filename) !== filename || !/^[a-zA-Z0-9_-]+\.(bin|png|jpg|webp)$/.test(filename)) return fail('图片文件标识无效');
    return path.join(this.root, filename);
  }
  private persist(changed: AssetRecord[] = []): Promise<void> {
    const write = async () => {
      const atomicJSON = async (target: string, value: unknown, limit: number) => {
        const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > limit) fail('图片索引超出安全限制');
        const temp = path.join(path.dirname(target), `manifest-${randomUUID()}.tmp`);
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        try { await fs.rename(temp, target); } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      };
      // A shard contains one whole generation response (or one reference), so large batches do not
      // repeatedly rewrite an ever-growing monolithic manifest and each staged response commits atomically.
      for (const key of new Set(changed.map(asset => this.groupKey(asset)))) {
        const records = [...(this.groups.get(key) ?? [])].map(id => this.assets.get(id)!);
        if (records.length) await atomicJSON(path.join(this.root, 'metadata', `${key}.json`), records, MB);
      }
      await atomicJSON(path.join(this.root, MANIFEST_NAME), { version: 2, directories: [...this.directories] } satisfies Manifest, 16 * MB);
    };
    const next = this.manifestQueue.then(write, write); this.manifestQueue = next.catch(() => {}); return next;
  }
  /** Only call with a trusted main-process native directory selection (or the OS default output directory). */
  async registerOutputDirectory(directory: string): Promise<string> {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('请选择有效的保存文件夹');
    const real = await fs.realpath(directory); if (!(await fs.stat(real)).isDirectory()) fail('请选择有效的保存文件夹');
    this.directories.add(real); await this.persist(); return real;
  }
  async importRows(filename: string): Promise<string[]> {
    const extension = path.extname(filename).toLowerCase();
    if (extension !== '.xlsx') fail('仅支持 XLSX 表格文件');
    return parseXlsxRows(await readBounded(filename, MAX_IMPORT_BYTES));
  }
  /** The destination comes only from Save As; existing files are never overwritten. */
  async exportBatchTemplate(selectedPath: string): Promise<void> {
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) fail('请选择有效的保存位置');
    const directory = await fs.realpath(path.dirname(selectedPath));
    const name = path.basename(selectedPath);
    if (safeBasename(name) !== name || path.extname(name).toLowerCase() !== '.xlsx') fail('模板文件必须使用 .xlsx 扩展名');
    const bytes = await createBatchTemplate();
    let handle;
    try { handle = await fs.open(path.join(directory, name), 'wx', 0o600); }
    catch (error: any) { if (error.code === 'EEXIST') fail('文件已存在，请更换名称以免覆盖原文件'); throw error; }
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch { fail('保存未完成，目标位置可能有不完整文件，请检查后重试'); }
    finally { await handle.close(); }
  }
  private async process(bytes: Uint8Array, format?: ImageFormat): Promise<ImageOutput> {
    // Bound native pixel memory as well as V8 worker memory; concurrent downloads may proceed.
    const run = () => this.processNow(bytes, format);
    const next = this.imageQueue.then(run, run); this.imageQueue = next.catch(() => {}); return next;
  }
  private async processNow(bytes: Uint8Array, format?: ImageFormat): Promise<ImageOutput> {
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) fail('图片超过 32 MB');
    if (this.options.imageProcessor) return this.options.imageProcessor(bytes, format);
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.options.workerPath ?? path.join(__dirname, 'image-worker.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const finish = (error?: Error, result?: ImageOutput) => { clearTimeout(timer); worker.removeAllListeners(); void worker.terminate(); error ? reject(error) : resolve(result!); };
      const timer = setTimeout(() => finish(new Error('图片处理超时')), 30_000);
      worker.once('message', message => message.ok ? finish(undefined, message.result) : finish(new Error('图片无效、已损坏或超过安全尺寸限制')));
      worker.once('error', () => finish(new Error('图片处理失败')));
      worker.once('exit', () => finish(new Error('图片处理意外中断')));
      worker.postMessage({ bytes, format });
    });
  }
  async importReferences(filenames: string[], existingReferenceIds: string[] = []): Promise<Reference[]> {
    const run = async () => {
      if (!Array.isArray(filenames) || !filenames.length || filenames.length + existingReferenceIds.length > 8) fail('最多选择 8 张参考图');
      const active = existingReferenceIds.map(id => this.getAsset(id, 'reference'));
      let total = active.reduce((sum, asset) => sum + asset.size, 0);
      const imported: AssetRecord[] = [];
      try {
        for (const filename of filenames) {
          const bytes = await readBounded(filename, MAX_REFERENCE_BYTES); total += bytes.length;
          if (total > MAX_REFERENCE_TOTAL) fail('参考图总大小不能超过 100 MB');
          const image = await this.process(bytes), id = randomUUID();
          const asset: AssetRecord = { id, kind: 'reference', name: safeBasename(filename), file: `${id}.bin`, thumbnail: `${id}-thumb.webp`, mime: image.mime, size: bytes.length };
          imported.push(asset);
          await this.writeNewManaged(asset.file!, bytes);
          await this.writeNewManaged(asset.thumbnail!, image.thumbnail);
        }
        for (const asset of imported) this.putAsset(asset);
        await this.persist(imported); return imported.map(asset => ({ id: asset.id, name: asset.name, url: assetURL(asset.id) }));
      } catch (error) {
        for (const asset of imported) { this.deleteAsset(asset); await fs.rm(this.managedPath(asset.file!), { force: true }).catch(() => {}); await fs.rm(this.managedPath(asset.thumbnail!), { force: true }).catch(() => {}); }
        throw error;
      }
    };
    const next = this.referenceQueue.then(run, run); this.referenceQueue = next.catch(() => {}); return next;
  }
  private getAsset(id: string, kind?: AssetRecord['kind']): AssetRecord {
    const asset = this.assets.get(validId(id)); if (!asset || (kind && asset.kind !== kind)) return fail('图片不存在'); return asset;
  }
  resolveAsset(id: string): { path: string; mimeType: string } | undefined {
    try { const asset = this.getAsset(id); if (!asset.thumbnail) return undefined; return { path: this.managedPath(asset.thumbnail), mimeType: 'image/webp' }; } catch { return undefined; }
  }
  resolveResultPath(id: string): string | undefined {
    try { const asset = this.getAsset(id, 'result'); return asset.outputPath || (asset.file ? this.managedPath(asset.file) : undefined); } catch { return undefined; }
  }
  resolveFullResult(id: string): { path: string; mimeType: string } | undefined {
    try { const asset = this.getAsset(id, 'result'); if (!asset.file || !asset.mime) return undefined; return { path: this.managedPath(asset.file), mimeType: asset.mime }; } catch { return undefined; }
  }
  resolveFullReference(id: string): { path: string; mimeType: string; name: string } | undefined {
    try { const asset = this.getAsset(id, 'reference'); if (!asset.file || !asset.mime) return undefined; return { path: this.managedPath(asset.file), mimeType: asset.mime, name: asset.name }; } catch { return undefined; }
  }
  async resultAsPng(id: string): Promise<Uint8Array> {
    const asset = this.getAsset(id, 'result');
    if (!asset.file) fail('图片文件不存在');
    return (await this.process(await readBounded(this.managedPath(asset.file!), MAX_DOWNLOAD_BYTES), 'png')).bytes;
  }
  async referenceAsPng(id: string): Promise<Uint8Array> {
    const asset = this.getAsset(id, 'reference');
    if (!asset.file) fail('参考图文件不存在');
    return (await this.process(await readBounded(this.managedPath(asset.file!), MAX_REFERENCE_BYTES), 'png')).bytes;
  }
  /** The destination comes only from the native Save As dialog; never replace an existing file. */
  async exportReference(id: string, selectedPath: string): Promise<void> {
    const asset = this.getAsset(id, 'reference');
    if (!asset.file || !asset.mime) fail('参考图文件不存在');
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) fail('请选择有效的保存位置');
    const directory = await fs.realpath(path.dirname(selectedPath));
    const name = path.basename(selectedPath), ext = path.extname(name).toLowerCase();
    const allowed = asset.mime === 'image/png' ? ['.png'] : asset.mime === 'image/jpeg' ? ['.jpg', '.jpeg'] : asset.mime === 'image/webp' ? ['.webp'] : [];
    if (safeBasename(name) !== name || !allowed.includes(ext)) fail('保存扩展名必须与原图格式一致');
    const bytes = await readBounded(this.managedPath(asset.file!), MAX_REFERENCE_BYTES);
    let handle;
    try { handle = await fs.open(path.join(directory, name), 'wx', 0o600); }
    catch (error: any) { if (error.code === 'EEXIST') fail('文件已存在，请更换名称以免覆盖图片'); throw error; }
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch { fail('保存未完成，目标位置可能有不完整文件，请检查后重试'); }
    finally { await handle.close(); }
  }
  async read(reference: Reference): Promise<{ name: string; mime: string; data: Uint8Array }> {
    const asset = this.getAsset(reference.id, 'reference'); if (!asset.file || !asset.mime) fail('参考图数据缺失');
    return { name: asset.name, mime: asset.mime!, data: await readBounded(this.managedPath(asset.file!), MAX_REFERENCE_BYTES) };
  }
  async fromResult(result: ResultImage, existingReferenceIds: string[] = []): Promise<Reference> {
    const asset = this.getAsset(result.id, 'result'); if (!asset.file) fail('请先完成图片下载');
    const [reference] = await this.importReferences([this.managedPath(asset.file)], existingReferenceIds); return reference;
  }
  async stage(images: ProviderImage[], context: OutputContext): Promise<StoredImage[]> {
    validateContext(context); if (!Array.isArray(images) || !images.length || images.length > 16) fail('图片返回数量无效');
    const records: AssetRecord[] = [];
    try {
      for (let i = 0; i < images.length; i++) {
        const image = images[i], id = randomUUID();
        if ((!image.bytes && !image.url) || (image.bytes && image.url)) fail('图片返回内容无效');
        const asset: AssetRecord = { id, kind: 'result', name: `图片-${context.row}-${i + 1}`, size: image.bytes?.byteLength ?? 0, context: { ...context, index: i + 1 }, stageCount: images.length };
        records.push(asset);
        if (image.url) { validateDownloadURL(image.url); asset.sourceURL = image.url; }
        if (image.bytes) { if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength > MAX_DOWNLOAD_BYTES) fail('返回图片超过 32 MB'); asset.file = `${id}.bin`; await this.writeNewManaged(asset.file, image.bytes); }
      }
      for (const asset of records) this.putAsset(asset);
      await this.persist(records); return records.map(asset => ({ id: asset.id }));
    } catch (error) {
      for (const asset of records) { this.deleteAsset(asset); if (asset.file) await fs.rm(this.managedPath(asset.file), { force: true }).catch(() => {}); }
      throw error;
    }
  }
  async recover(context: OutputContext): Promise<StoredImage[]> {
    validateContext(context);
    const records = [...this.assets.values()].filter(asset => asset.kind === 'result' && asset.context?.jobId === context.jobId && asset.context?.taskId === context.taskId).sort((a,b) => a.context!.index - b.context!.index);
    if (!records.length || records.some((asset, index) => asset.stageCount !== records.length || asset.context!.index !== index + 1)) return [];
    return records.map(asset => ({ id: asset.id }));
  }
  async write(image: StoredImage, context: OutputContext): Promise<ResultImage> {
    const id = validId(image.id); const existing = this.writes.get(id); if (existing) return existing;
    const pending = this.writeInternal(id, context); this.writes.set(id, pending);
    try { return await pending; } finally { this.writes.delete(id); }
  }
  private async writeInternal(id: string, context: OutputContext): Promise<ResultImage> {
    validateContext(context);
    const asset = this.getAsset(id, 'result');
    if (asset.context && (asset.context.taskId !== context.taskId || asset.context.jobId !== context.jobId)) fail('图片任务不匹配');
    if (asset.outputPath && asset.thumbnail) return this.resultDTO(asset);
    if (!asset.file) {
      if (!asset.sourceURL) fail('图片数据缺失');
      const bytes = await (this.options.download ?? downloadImage)(asset.sourceURL);
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) fail('图片下载超过 32 MB');
      const filename = `${id}-${randomUUID()}.bin`;
      await this.writeNewManaged(filename, bytes);
      asset.file = filename; asset.size = bytes.length; await this.persist([asset]);
    }
    const bytes = await readBounded(this.managedPath(asset.file), MAX_DOWNLOAD_BYTES);
    let converted: ImageOutput;
    try { converted = await this.process(bytes, context.format); }
    catch (error) {
      // A server may have returned a corrupt/truncated response. Keep the staged source and allow a fresh GET.
      if (asset.sourceURL && asset.file.endsWith('.bin')) {
        const corruptFile = asset.file; asset.file = undefined; asset.size = 0; await this.persist([asset]);
        await fs.rm(this.managedPath(corruptFile), { force: true }).catch(() => {});
      }
      throw error;
    }
    const filename = `${id}.${context.format}`, thumb = `${id}-thumb.webp`;
    await this.replaceManaged(filename, converted.bytes); await this.replaceManaged(thumb, converted.thumbnail);
    asset.file = filename; asset.thumbnail = thumb; asset.mime = converted.mime; asset.size = converted.bytes.length; asset.context = { ...context };
    await this.persist([asset]);
    if (context.outputDirectory) {
      const directory = await this.outputDirectory(context);
      const date = localDateStamp(context.createdAt);
      const base = context.naming.replace(/\{序号\}/g, `${String(context.row).padStart(4,'0')}-${String(context.index).padStart(2,'0')}`).replace(/\{日期\}/g, date);
      const name = safeBasename(`${base}_run-${context.run}_row-${context.row}_image-${context.index}`);
      asset.outputPath = await this.atomicOutput(directory, `${name}.${context.format}`, converted.bytes);
      asset.name = path.basename(asset.outputPath); await this.persist([asset]);
    } else { asset.name = `图片-${context.row}-${context.index}.${context.format}`; await this.persist([asset]); }
    return this.resultDTO(asset);
  }
  private resultDTO(asset: AssetRecord): ResultImage { return { id: asset.id, name: asset.name, url: assetURL(asset.id), favorite: false, saved: !!asset.outputPath }; }
  private async writeNewManaged(filename: string, bytes: Uint8Array): Promise<void> {
    const handle = await fs.open(this.managedPath(filename), 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  private async replaceManaged(filename: string, bytes: Uint8Array): Promise<void> {
    const target = this.managedPath(filename), temporaryName = `${randomUUID()}.bin`, temporary = this.managedPath(temporaryName);
    await this.writeNewManaged(temporaryName, bytes);
    try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  private async outputDirectory(context: OutputContext): Promise<string> {
    const root = await fs.realpath(context.outputDirectory);
    if (!this.directories.has(root)) fail('请通过选择文件夹按钮授权保存位置');
    let target = root;
    for (const component of [context.taskKind === 'batch' ? '批量任务' : '单图任务', context.taskId, `run-${context.run}`]) {
      target = path.join(target, component); await fs.mkdir(target, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(target); if (stat.isSymbolicLink() || !stat.isDirectory()) fail('保存目录包含不安全的链接');
      const real = await fs.realpath(target); if (!inside(root, real)) fail('保存目录超出授权范围'); target = real;
    }
    return target;
  }
  /** A fully-written temporary inode is linked into place; existing destinations are never overwritten. */
  private async atomicOutput(directory: string, desired: string, bytes: Uint8Array, exact = false): Promise<string> {
    const temporary = path.join(directory, `.qingtu-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      const extension = path.extname(desired), base = desired.slice(0, -extension.length);
      for (let suffix = 0; suffix < 10_000; suffix++) {
        const target = path.join(directory, suffix ? `${base}_${suffix}${extension}` : desired);
        try {
          try { await (this.options.link ?? fs.link)(temporary, target); }
          catch (error: any) {
            if (!['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV','ENOSYS'].includes(error.code)) throw error;
            // FAT/exFAT may not support links. Exclusive creation still never overwrites; only NTFS/link-capable
            // filesystems provide atomic visibility. On I/O failure remove only the file we successfully created.
            const final = await fs.open(target, 'wx', 0o600);
            try { await final.writeFile(bytes); await final.sync(); }
            catch (writeError) { await final.close(); await fs.rm(target, { force: true }).catch(() => {}); throw writeError; }
            await final.close();
          }
          return target;
        } catch (error: any) { if (error.code !== 'EEXIST') throw error; if (exact) fail('文件已存在，请更换名称以免覆盖图片'); }
      }
      return fail('同名文件过多，请更改命名模板');
    } finally { await fs.rm(temporary, { force: true }); }
  }
  /** Native Save dialog only: exact authorized filename, actual format conversion, no overwrite. */
  async exportResult(resultId: string, selectedPath: string): Promise<ResultImage> {
    const asset = this.getAsset(resultId, 'result'); if (!asset.file || !asset.context) fail('请先完成图片下载');
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) fail('请选择有效的保存位置');
    const directory = await fs.realpath(path.dirname(selectedPath));
    if (!this.directories.has(directory)) fail('请先选择保存文件夹');
    const desired = path.basename(selectedPath), extension = path.extname(desired).toLowerCase();
    if (safeBasename(desired) !== desired || !['.png','.jpg','.jpeg','.webp'].includes(extension)) fail('保存文件名必须使用 PNG、JPG 或 WebP 扩展名');
    const format: ImageFormat = extension === '.jpeg' ? 'jpg' : extension.slice(1) as ImageFormat;
    const converted = await this.process(await readBounded(this.managedPath(asset.file), MAX_DOWNLOAD_BYTES), format);
    asset.outputPath = await this.atomicOutput(directory, desired, converted.bytes, true);
    asset.name = desired; await this.persist([asset]); return this.resultDTO(asset);
  }
  async saveResult(resultId: string, directory: string): Promise<ResultImage> {
    const asset = this.getAsset(resultId, 'result'); if (!asset.context) fail('图片输出信息缺失');
    // Exporting an existing result may target a different user-selected directory; its provider is never called.
    const real = await fs.realpath(directory); if (!this.directories.has(real)) fail('请先选择保存文件夹');
    if (!asset.file) return this.write({ id: resultId }, { ...asset.context, outputDirectory: real });
    const context = { ...asset.context, outputDirectory: real }; const target = await this.outputDirectory(context);
    const converted = await this.process(await readBounded(this.managedPath(asset.file), MAX_DOWNLOAD_BYTES), context.format);
    asset.outputPath = await this.atomicOutput(target, safeBasename(asset.name.endsWith(`.${context.format}`) ? asset.name : `${asset.name}.${context.format}`), converted.bytes);
    asset.name = path.basename(asset.outputPath); await this.persist([asset]); return this.resultDTO(asset);
  }
}
