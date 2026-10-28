const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'../node_modules/@img/sharp-win32-x64/lib');
for(const name of ['sharp-win32-x64-0.35.5.node','libvips-42.dll','libvips-cpp-8.18.7.dll']) {
 const file=path.join(root,name);
 if(!fs.existsSync(file))throw new Error('缺少 Windows x64 图片依赖 '+name+'；请在 Windows x64 上执行 npm ci，或先安装目标平台的 @img/sharp-win32-x64。');
 const bytes=fs.readFileSync(file);const pe=bytes.readUInt32LE(0x3c);
 if(bytes.toString('ascii',0,2)!=='MZ'||bytes.toString('ascii',pe,pe+4)!=='PE\0\0'||bytes.readUInt16LE(pe+4)!==0x8664)throw new Error('原生依赖并非 Windows x64：'+name);
}
console.log('Windows x64 图片原生依赖检查通过');
