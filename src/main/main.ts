import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, realpath } from 'node:fs/promises';
import { ACTIONS, type Action, type AppState } from '../shared/types';
import { CredentialVault } from './credentials';
import { Engine } from './engine';
import { SQLiteStore } from './store';
import { FileService } from './files';
import { ImageProvider } from './provider';
import { PRODUCT } from './product';

app.setName(PRODUCT.name);
// The development window has its own database and lock, so it can run beside the installed app.
const isDev = !app.isPackaged && process.env.QINGTU_DEV === '1';
const devOrigin = 'http://127.0.0.1:5173';
if (isDev) app.setPath('userData', path.join(app.getPath('appData'), '轻图-dev'));
protocol.registerSchemesAsPrivileged([
 {scheme:'qingtu-app',privileges:{standard:true,secure:true,supportFetchAPI:true}},
 {scheme:'qingtu-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}},
]);
const single=app.requestSingleInstanceLock();
if(!single)app.quit();
let window:BrowserWindow|undefined;
let engine:Engine;
let files:FileService;
let vault:CredentialVault;
let provider:ImageProvider;
let allowClose=false;
let closePrompt=false;
const nativePending=new Set<string>();
const allowedDirectories=new Set<string>();
const stateEvent=(state:AppState)=>{if(window&&!window.isDestroyed())window.webContents.send('qingtu:state',state);};
const errorText=(error:unknown)=>{
 const text=error instanceof Error?error.message:'操作失败，请重试';
 if(/sk-[\w-]{8,}|Bearer\s|https?:\/\/[^\s]+|authorization|password|token=/i.test(text))return '操作失败，请检查配置或网络后重试';
 return text.slice(0,500);
};
async function nativeOnce<T>(name:string,fn:()=>Promise<T>):Promise<T> {
 if(nativePending.has(name))throw new Error('该操作正在处理中，请稍候');
 nativePending.add(name);try{return await fn();}finally{nativePending.delete(name);}
}
function getTask(id:unknown) {
 if(typeof id!=='string')throw new Error('请选择任务');
 const task=engine.getState().tasks.find(t=>t.id===id);
 if(!task)throw new Error('任务不存在');return task;
}
async function registerDirectory(directory:string) {
 await files.registerOutputDirectory(directory);
 allowedDirectories.add(path.resolve(directory));
}
function assertDirectory(directory:unknown) {
 if(typeof directory!=='string'||!allowedDirectories.has(path.resolve(directory)))throw new Error('请使用目录选择按钮设置保存目录');
}
async function execute(action:Action,p:Record<string,unknown>):Promise<unknown> {
 const win=window!;
 switch(action) {
 case 'windowMinimize':win.minimize();return true;
 case 'windowMaximize':win.isMaximized()?win.unmaximize():win.maximize();return true;
 case 'windowClose':win.close();return true;
 case 'chooseOutputDirectory':return nativeOnce('directory',async()=>{
   const selected=await dialog.showOpenDialog(win,{title:'选择图片保存目录',properties:['openDirectory','createDirectory']});
   if(selected.canceled||!selected.filePaths[0])return null;
   const directory=selected.filePaths[0];await registerDirectory(directory);
   if(p.id)await engine.execute('updateTask',{id:p.id,outputDirectory:directory});
   return directory;
 });
 case 'importRows':return nativeOnce('import',async()=>{
   const task=getTask(p.id);if(task.kind!=='batch')throw new Error('仅批量任务支持导入');
   const selected=await dialog.showOpenDialog(win,{title:'导入提示词表格',properties:['openFile'],filters:[{name:'Excel 表格',extensions:['xlsx']}]});
   if(selected.canceled||!selected.filePaths[0])return engine.getState();
   const rows=await files.importRows(selected.filePaths[0]);
   return engine.setRows(task.id,rows);
 });
 case 'downloadBatchTemplate':return nativeOnce('batch-template',async()=>{
   const selected=await dialog.showSaveDialog(win,{title:'保存批量提示词模板',defaultPath:'批量提示词模板.xlsx',filters:[{name:'Excel 表格',extensions:['xlsx']}]});
   if(selected.canceled||!selected.filePath)return false;
   await files.exportBatchTemplate(selected.filePath);return true;
 });
 case 'selectReferences':return nativeOnce('references',async()=>{
   const task=getTask(p.id);if(task.kind!=='single')throw new Error('仅生成页支持参考图');
   const selected=await dialog.showOpenDialog(win,{title:'选择参考图',properties:['openFile','multiSelections'],filters:[{name:'参考图片',extensions:['png','jpg','jpeg','webp']}]});
   if(selected.canceled)return engine.getState();
   const refs=await files.importReferences(selected.filePaths,task.referenceIds);
   return engine.addReferences(task.id,refs);
 });
 case 'openResult': {
   if(typeof p.resultId!=='string')throw new Error('请选择图片');
   const file=await files.resolveResultPath(p.resultId);
   if(!file)throw new Error('图片文件不存在');
   const result=await shell.openPath(file);if(result)throw new Error('无法打开图片，请检查文件是否仍然存在');return true;
 }
 case 'copyResult': return nativeOnce('copy-result',async()=>{
   if(typeof p.resultId!=='string')throw new Error('请选择图片');
   const bytes=await files.resultAsPng(p.resultId);
   await clipboard.write([new ClipboardItem({'image/png':new Blob([Uint8Array.from(bytes)],{type:'image/png'})})]);return true;
 });
 case 'copyReference': return nativeOnce('copy-reference',async()=>{
   if(typeof p.referenceId!=='string')throw new Error('请选择参考图');
   const bytes=await files.referenceAsPng(p.referenceId);
   await clipboard.write([new ClipboardItem({'image/png':new Blob([Uint8Array.from(bytes)],{type:'image/png'})})]);return true;
 });
 case 'saveReference': return nativeOnce('save-reference',async()=>{
   if(typeof p.referenceId!=='string')throw new Error('请选择参考图');
   const file=files.resolveFullReference(p.referenceId);if(!file)throw new Error('参考图文件不存在');
   const extensions=file.mimeType==='image/png'?['png']:file.mimeType==='image/jpeg'?['jpg','jpeg']:file.mimeType==='image/webp'?['webp']:[];
   if(!extensions.length)throw new Error('参考图格式不受支持');
   const defaultName=`${path.parse(file.name).name}.${extensions[0]}`;
   const selected=await dialog.showSaveDialog(win,{title:'另存参考图',defaultPath:defaultName,filters:[{name:'原图格式',extensions}]});
   if(selected.canceled||!selected.filePath)return false;
   await files.exportReference(p.referenceId,selected.filePath);return true;
 });
 case 'saveResult':return nativeOnce('save-result',async()=>{
   if(typeof p.resultId!=='string')throw new Error('请选择图片');
   const file=await files.resolveResultPath(p.resultId);if(!file)throw new Error('图片文件不存在');
   const selected=await dialog.showSaveDialog(win,{title:'另存图片',defaultPath:path.basename(file),filters:[{name:'图片',extensions:[path.extname(file).slice(1)]}]});
   if(selected.canceled||!selected.filePath)return false;
   if(path.resolve(file)===path.resolve(selected.filePath))return true;
   await registerDirectory(path.dirname(selected.filePath));
   await files.exportResult(p.resultId,selected.filePath);
   await engine.markResultSaved(p.resultId);return true;
 });
 case 'enhancePrompt':return nativeOnce('enhance',()=>engine.execute('enhancePrompt',p));
 case 'openLink': {
   const name=p.name as keyof typeof PRODUCT.links;
   if(!Object.prototype.hasOwnProperty.call(PRODUCT.links,name))throw new Error('无效的链接');
   const link=PRODUCT.links[name];if(!link)throw new Error('此链接尚未配置');
   const url=new URL(link);if(url.protocol!=='https:'||url.username||url.password)throw new Error('链接配置无效');
   await shell.openExternal(url.href);return true;
 }
 case 'checkUpdate':return {available:false,message:'尚未配置版本更新地址'};
 default:
   if((action==='saveSettings'||action==='updateTask')&&p.outputDirectory!==undefined)assertDirectory(p.outputDirectory);
   return engine.execute(action,p);
 }
}
async function start() {
 const dataDir=app.getPath('userData');await mkdir(dataDir,{recursive:true});
 const defaultOutput=path.join(app.getPath('pictures'),'轻图');await mkdir(defaultOutput,{recursive:true});
 vault=new CredentialVault(dataDir,safeStorage);await vault.init();
 const workerPath=app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','dist-main','image-worker.cjs'):path.join(__dirname,'image-worker.cjs');
 files=new FileService(dataDir,{workerPath});await files.init();
 await registerDirectory(defaultOutput);
 provider=new ImageProvider();
 engine=new Engine({store:new SQLiteStore(path.join(dataDir,'qingtu.sqlite')),provider,credentials:vault,output:files,references:files,onState:stateEvent,version:PRODUCT.version,textModel:PRODUCT.textModel});
 await engine.init();
 if(!engine.getState().settings.outputDirectory)await engine.execute('saveSettings',{outputDirectory:defaultOutput});
 const initial=engine.getState();
 for(const dir of new Set([initial.settings.outputDirectory,...initial.tasks.map(x=>x.outputDirectory)])) {
   if(dir)try{await registerDirectory(dir);}catch{/* Missing disks remain a recoverable output error. */}
 }
 const dist=await realpath(path.join(__dirname,'../dist'));
 protocol.handle('qingtu-app',async request=>{
   try {
     const url=new URL(request.url);if(url.hostname!=='app')return new Response(null,{status:404});
     const pathname=decodeURIComponent(url.pathname);
     const file=await realpath(path.join(dist,pathname==='/'?'index.html':pathname));
     if(!file.startsWith(dist+path.sep))return new Response(null,{status:403});
     return net.fetch(pathToFileURL(file).href);
   }catch{return new Response(null,{status:404});}
 });
 protocol.handle('qingtu-asset',async request=>{
   try {
     const url=new URL(request.url);const pathname=decodeURIComponent(url.pathname);const kind=pathname.startsWith('/result/')?'result':pathname.startsWith('/reference/')?'reference':'thumbnail';const id=kind==='thumbnail'?pathname.slice(1):pathname.slice(kind.length+2);
     if(url.hostname!=='asset'||!/^[a-zA-Z0-9_-]{1,160}$/.test(id))return new Response(null,{status:404});
     const file=kind==='result'?files.resolveFullResult(id):kind==='reference'?files.resolveFullReference(id):files.resolveAsset(id);if(!file)return new Response(null,{status:404});
     const response=await net.fetch(pathToFileURL(file.path).href);
     return new Response(response.body,{status:response.status,headers:{'Content-Type':file.mimeType,'X-Content-Type-Options':'nosniff'}});
   }catch{return new Response(null,{status:404});}
 });
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 window=new BrowserWindow({width:1600,height:1000,minWidth:1100,minHeight:720,frame:false,backgroundColor:'#0b0e15',title:isDev?'轻图 · 开发版':PRODUCT.name,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 if(isDev) window.on('page-title-updated',event=>event.preventDefault());
 window.webContents.on('will-navigate',event=>event.preventDefault());
 ipcMain.handle('qingtu:command',async(event,action:unknown,payload:unknown)=>{
   try {
     const senderUrl = event.senderFrame?.url;
     const allowedOrigin = senderUrl && (isDev ? senderUrl === `${devOrigin}/` : senderUrl.startsWith('qingtu-app://app/'));
     if(event.sender!==window?.webContents||event.senderFrame!==event.sender.mainFrame||!allowedOrigin)throw new Error('操作来源无效');
     if(typeof action!=='string'||!ACTIONS.includes(action as Action))throw new Error('不支持的操作');
     if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>2*1024*1024)throw new Error('操作参数无效');
     return {ok:true,value:await execute(action as Action,payload as Record<string,unknown>)};
   }catch(error){return {ok:false,error:errorText(error)};}
 });
 window.on('close',event=>{
   if(allowClose||!engine.hasActiveJobs()){engine.stop();return;}
   event.preventDefault();if(closePrompt)return;closePrompt=true;
   void dialog.showMessageBox(window!,{type:'warning',title:'仍有任务正在生成',message:'现在退出会中断结果接收，重新生成可能重复消耗额度。',buttons:['继续等待','退出程序'],defaultId:0,cancelId:0}).then(result=>{if(result.response===1){engine.stop();allowClose=true;app.quit();}}).finally(()=>{closePrompt=false;});
 });
 window.once('ready-to-show',()=>window?.show());
 await window.loadURL(isDev ? `${devOrigin}/` : 'qingtu-app://app/index.html');
}
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('window-all-closed',()=>app.quit());
if(single)void app.whenReady().then(start).catch(error=>{dialog.showErrorBox('轻图启动失败',errorText(error));app.quit();});
