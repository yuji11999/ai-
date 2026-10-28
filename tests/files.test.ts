import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { FileService, downloadImage, isPublicAddress, validateDownloadURL, validateNaming, validateXlsxArchive, type OutputContext } from '../src/main/files';
import { processImageBuffer, sniffImage } from '../src/main/image-worker';

const fixtures: string[] = [];
test.after(async () => { await Promise.all(fixtures.map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() { const dir = await fs.mkdtemp(path.join(os.tmpdir(),'qingtu-files-')); fixtures.push(dir); const files = new FileService(path.join(dir,'data'), { imageProcessor: processImageBuffer }); await files.init(); return { dir, files }; }
const context = (directory = ''): OutputContext => ({taskId:'task-1',taskKind:'batch',jobId:'job-1',run:1,row:1,index:1,outputDirectory:directory,naming:'{序号}_{日期}',format:'png',createdAt:Date.UTC(2026,9,28)});
async function png() { return sharp({create:{width:32,height:20,channels:4,background:{r:240,g:30,b:80,alpha:0.6}}}).png().toBuffer(); }

test('only XLSX files are accepted for bulk import', async () => {
  const files = new FileService('unused');
  await assert.rejects(files.importRows('prompts.txt'), /仅支持 XLSX/);
  await assert.rejects(files.importRows('prompts.csv'), /仅支持 XLSX/);
});

test('XLSX uses the first worksheet and rejects formula cells', async () => {
  const { dir, files } = await fixture(); const filename = path.join(dir,'rows.xlsx');
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('first');
  sheet.addRows([['prompt','ignored'],['same','ignore this'],[],['same'],['last']]); workbook.addWorksheet('second').addRow(['not imported']);
  await workbook.xlsx.writeFile(filename); assert.deepEqual((await files.importRows(filename)).map(row=>row.prompt),['same','same','last']);
  sheet.getCell('A3').value = { formula: 'HYPERLINK("https://example.com","x")', result: 'never evaluate' };
  await workbook.xlsx.writeFile(filename); await assert.rejects(files.importRows(filename),/包含公式/);
});

test('ZIP preflight checks actual inflation, metadata sizes, external entities and paths', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('rows').addRow(['hello']);
  const original = Buffer.from(await workbook.xlsx.writeBuffer()); validateXlsxArchive(original);
  const corrupt = Buffer.from(original); const central = corrupt.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  corrupt.writeUInt32LE(101*1024*1024,central+24); assert.throws(()=>validateXlsxArchive(corrupt), /解压/);
  const understated = Buffer.from(original); let p = understated.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  while (understated.readUInt32LE(p+24) === 0) p += 46 + understated.readUInt16LE(p+28) + understated.readUInt16LE(p+30) + understated.readUInt16LE(p+32);
  understated.writeUInt32LE(1,p+24); assert.throws(()=>validateXlsxArchive(understated),/解压/);
});

test('references require real images, generate thumbnails, enforce aggregate count and survive restart', async () => {
  const { dir, files } = await fixture(); const original = path.join(dir,'not-an-extension.txt'); await fs.writeFile(original,await png());
  const [reference] = await files.importReferences([original]); assert.match(reference.url,/^qingtu-asset:\/\/asset\/[a-z0-9-]+$/);
  assert.ok(!reference.url.includes(dir)); assert.equal((await files.read(reference)).mime,'image/png');
  const asset = files.resolveAsset(reference.id)!; assert.equal((await sharp(asset.path).metadata()).format,'webp');
  assert.equal(files.resolveAsset('../../etc/passwd'),undefined); assert.equal(files.resolveResultPath(reference.id),undefined);
  await assert.rejects(files.importReferences(Array(8).fill(original),[reference.id]),/8 张/);
  const fake = path.join(dir,'fake.png'); await fs.writeFile(fake,'<svg xmlns="http://www.w3.org/2000/svg"></svg>'); await assert.rejects(files.importReferences([fake]),/PNG/);
  const restored = new FileService(path.join(dir,'data'),{imageProcessor:processImageBuffer}); await restored.init(); assert.deepEqual(await restored.read(reference),await files.read(reference));
});

test('image processor performs true JPEG/WebP conversion and rejects oversized pixel headers', async () => {
  const original = await png(); const jpg = await processImageBuffer(original,'jpg'); const webp = await processImageBuffer(original,'webp');
  assert.equal(sniffImage(jpg.bytes),'jpeg'); assert.equal(sniffImage(webp.bytes),'webp'); assert.equal(jpg.mime,'image/jpeg');
  const large = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(processImageBuffer(large),/pixel limit|尺寸/);
});

test('result conversion, whitelisted directories, atomic nonoverwrite and restart recovery', async () => {
  const { dir, files } = await fixture(); const output = path.join(dir,'output'); await fs.mkdir(output);
  const c = {...context(output),format:'jpg' as const}; const [staged] = await files.stage([{bytes:await png()}],c);
  await assert.rejects(files.write(staged,c),/授权保存/);
  await files.registerOutputDirectory(output); const result = await files.write(staged,c); assert.equal(result.saved,true);
  const resultPath = files.resolveResultPath(result.id)!; assert.match(resultPath,/批量任务.*task-1.*run-1/); assert.equal((await sharp(resultPath).metadata()).format,'jpeg');
  const firstBytes = await fs.readFile(resultPath); const [second] = await files.stage([{bytes:await png()}],c); const secondResult = await files.write(second,c);
  assert.notEqual(files.resolveResultPath(secondResult.id),resultPath); assert.deepEqual(await fs.readFile(resultPath),firstBytes);
  assert.equal((await files.write(staged,c)).id,result.id);
  const restored = new FileService(path.join(dir,'data'),{imageProcessor:processImageBuffer}); await restored.init(); assert.equal(restored.resolveResultPath(result.id),resultPath);
  const reference = await restored.fromResult(result); assert.equal((await restored.read(reference)).mime,'image/jpeg');
  await assert.rejects(restored.read({id:'../../etc/passwd',name:'x',url:'x'}),/标识/);
});

test('failed URL download retries only download/save and keeps the staged id', async () => {
  const { dir } = await fixture(); let downloads = 0;
  const files = new FileService(path.join(dir,'retry'),{imageProcessor:processImageBuffer,download:async () => { downloads++; if (downloads === 1) throw new Error('simulated network failure'); return png(); }}); await files.init();
  const [staged] = await files.stage([{url:'https://images.example.com/image.png'}],context());
  assert.deepEqual(Object.keys(staged),['id']); await assert.rejects(files.write(staged,context()),/simulated/);
  const result = await files.write(staged,context()); assert.equal(result.id,staged.id); assert.equal(downloads,2); assert.ok(files.resolveAsset(result.id));
});

test('output symlinks and unsafe templates cannot escape selected folder', async () => {
  const {dir,files}=await fixture(); const output=path.join(dir,'out'), outside=path.join(dir,'outside'); await fs.mkdir(output); await fs.mkdir(outside); await files.registerOutputDirectory(output);
  await fs.symlink(outside,path.join(output,'批量任务'),process.platform === 'win32' ? 'junction' : 'dir'); const c=context(output), [image]=await files.stage([{bytes:await png()}],c);
  await assert.rejects(files.write(image,c),/不安全/);
  for (const naming of ['../x','{prompt}','a/b','a\\b','{序号}_{日期}.']) assert.throws(()=>validateNaming(naming));
  assert.equal(validateNaming('风景_{序号}_{日期}'),'风景_{序号}_{日期}');
});

test('download SSRF validation rejects private IPv4/IPv6, URL credentials and encoded loopback', async () => {
  for (const addr of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.100.100.200','198.18.0.1','0.0.0.0','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(addr),false,addr);
  assert.equal(isPublicAddress('8.8.8.8'),true); assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  for (const url of ['http://example.com/x','https://user:secret@example.com/x','https://127.1/x','https://0x7f000001/x','https://[::1]/x','file:///etc/passwd','https://metadata.google.internal/x']) assert.throws(()=>validateDownloadURL(url));
  await assert.rejects(downloadImage('https://images.example.com/x',{lookup:async()=>[{address:'127.0.0.1',family:4}] as any}),/禁止访问/);
});

function fakeRequest(status: number, content: Buffer, inspect?: (url: URL, options: any) => void): any {
  return (url: URL, options: any, responseCallback: (response: any) => void) => {
    inspect?.(url,options); const req = new EventEmitter() as any; req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const response=new PassThrough() as any; response.statusCode=status; response.headers={'content-length':String(content.length)}; responseCallback(response); response.end(content);}); return req;
  };
}
test('downloads pin vetted DNS, send no auth and refuse redirects without following them',async()=>{
  const lookup=async()=>[{address:'8.8.8.8',family:4}] as any;
  let pinned=''; const bytes=await png(); const downloaded=await downloadImage('https://images.example.com/x',{lookup,request:fakeRequest(200,bytes,(_url,options)=>{assert.equal(options.headers.Authorization,undefined); assert.equal(options.agent,false); options.lookup('attacker.invalid',{},(_error:any,address:string)=>{pinned=address;});})});
  assert.equal(pinned,'8.8.8.8'); assert.deepEqual(downloaded,bytes);
  await assert.rejects(downloadImage('https://images.example.com/x',{lookup,request:fakeRequest(302,Buffer.alloc(0))}),/重定向/);
  await assert.rejects(downloadImage('https://images.example.com/x',{lookup,request:fakeRequest(200,Buffer.alloc(33*1024*1024))}),/超过限制/);
});

test('native Save As converts by selected format and never overwrites an existing file', async () => {
  const {dir,files}=await fixture(); await files.registerOutputDirectory(dir); const [source]=await files.stage([{bytes:await png()}],context());
  const result=await files.write(source,context()), target=path.join(dir,'exported.webp'); await files.exportResult(result.id,target);
  assert.equal((await sharp(target).metadata()).format,'webp'); const bytes=await fs.readFile(target);
  await assert.rejects(files.exportResult(result.id,target),/文件已存在/); assert.deepEqual(await fs.readFile(target),bytes);
  await assert.rejects(files.exportResult(result.id,path.join(dir,'fake.svg')),/扩展名/);
});

test('FAT-like filesystems fall back to exclusive writes without overwriting existing results',async()=>{
  const {dir}=await fixture(); const files=new FileService(path.join(dir,'fat-data'),{imageProcessor:processImageBuffer,link:async()=>{throw Object.assign(new Error('unsupported link'),{code:'EPERM'});}}); await files.init(); await files.registerOutputDirectory(dir);
  const c=context(dir), [a]=await files.stage([{bytes:await png()}],c), [b]=await files.stage([{bytes:await png()}],{...c,jobId:'job-2'});
  const first=await files.write(a,c), second=await files.write(b,{...c,jobId:'job-2'});
  assert.notEqual(files.resolveResultPath(first.id),files.resolveResultPath(second.id));
  assert.equal((await sharp(files.resolveResultPath(first.id)!).metadata()).format,'png');
  assert.equal((await sharp(files.resolveResultPath(second.id)!).metadata()).format,'png');
});

test('corrupt downloaded bytes can be fetched afresh without regenerating',async()=>{
  const {dir}=await fixture(); let calls=0; const files=new FileService(path.join(dir,'corrupt'),{imageProcessor:processImageBuffer,download:async()=>++calls===1?Buffer.from('invalid image body'):png()}); await files.init();
  const [source]=await files.stage([{url:'https://images.example.com/x'}],context()); await assert.rejects(files.write(source,context()));
  assert.equal((await files.write(source,context())).id,source.id); assert.equal(calls,2);
});

test('staged responses recover by immutable job id after engine source commit is interrupted',async()=>{
  const {dir,files}=await fixture(), c=context(); const staged=await files.stage([{bytes:await png()},{url:'https://images.example.com/second.png'}],c);
  const restarted=new FileService(path.join(dir,'data'),{imageProcessor:processImageBuffer}); await restarted.init();
  assert.deepEqual(await restarted.recover(c),staged); assert.deepEqual(await restarted.recover({...c,jobId:'different-job'}),[]);
});

test('sharded metadata can exceed 16 MB total and still reopen without a monolithic size limit',async()=>{
  const {dir,files}=await fixture(); const longURL='https://images.example.com/image?signature='+ 'a'.repeat(9000); const response=Array.from({length:16},()=>({url:longURL}));
  for(let i=0;i<128;i++) await files.stage(response,{...context(),jobId:`large-job-${i}`});
  assert.ok((await fs.stat(path.join(dir,'data','assets','assets.json'))).size<1024);
  const restarted=new FileService(path.join(dir,'data'),{imageProcessor:processImageBuffer}); await restarted.init();
  assert.equal((await restarted.recover({...context(),jobId:'large-job-0'})).length,16);
  assert.equal((await restarted.recover({...context(),jobId:'large-job-127'})).length,16);
});

test('the real worker processes a reference outside the main thread',async()=>{
  const {dir}=await fixture(); const {transform}=await import('esbuild');
  const source=await fs.readFile(path.join(process.cwd(),'src/main/image-worker.ts'),'utf8');
  const code=await transform(source.replace("from 'sharp'",`from ${JSON.stringify(require.resolve('sharp'))}`),{loader:'ts',format:'cjs',platform:'node',target:'node22'});
  const workerPath=path.join(dir,'image-worker.cjs'); await fs.writeFile(workerPath,code.code);
  const files=new FileService(path.join(dir,'worker-data'),{workerPath}); await files.init(); const imagePath=path.join(dir,'worker.png'); await fs.writeFile(imagePath,await png());
  const [reference]=await files.importReferences([imagePath]); assert.equal((await files.read(reference)).mime,'image/png'); assert.ok(files.resolveAsset(reference.id));
});
