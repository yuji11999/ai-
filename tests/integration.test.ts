import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Engine } from '../src/main/engine';
import { SQLiteStore } from '../src/main/store';
import { FileService } from '../src/main/files';
import { processImageBuffer } from '../src/main/image-worker';
import { ImageProvider } from '../src/main/provider';
import { BUILTIN_URL } from '../src/shared/types';

test('integrated mock transport: generate two, save, reuse reference, edit, enhance and reopen SQLite',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'qingtu-integrated-'));
 const secrets=new Map<string,string>();
 const credentials={get:async(id:string)=>secrets.get(id),set:async(id:string,key:string)=>{secrets.set(id,key);},delete:async(id:string)=>{secrets.delete(id);}};
 const png=await sharp({create:{width:20,height:20,channels:4,background:'#6688ff'}}).png().toBuffer();
 const calls:Array<{url:string,body:unknown}>=[];
 const provider=new ImageProvider({fetch:(async(input,init)=>{
   const url=String(input);calls.push({url,body:init?.body});
   if(url.endsWith('/models'))return Response.json({data:[{id:'gpt-image-2'},{id:'gpt-5.6'}]});
   if(url.endsWith('/chat/completions'))return Response.json({choices:[{message:{content:'A small blue square on a white background.'}}]});
   let n=1;
   if(url.endsWith('/images/generations'))n=JSON.parse(init!.body as string).n;
   else if(url.endsWith('/images/edits')){
     const form=init!.body as FormData;assert.ok(form.getAll('image[]').length===1);n=Number(form.get('n'));
   }else throw new Error('Unexpected endpoint');
   return Response.json({data:Array.from({length:n},()=>({b64_json:png.toString('base64')}))});
 }) as typeof fetch});
 let store:SQLiteStore|undefined;
 let engine:Engine|undefined;
 try {
   const output=path.join(root,'output');await mkdir(output);
   const files=new FileService(root,{imageProcessor:processImageBuffer});await files.init();await files.registerOutputDirectory(output);
   store=new SQLiteStore(path.join(root,'data.sqlite'));
   engine=new Engine({store,provider,credentials,output:files,references:files,defaultOutputDirectory:output});await engine.init();
   await engine.execute('testProvider',{id:'builtin',baseURL:BUILTIN_URL,key:'mock-integration-key'});
   await engine.execute('saveProvider',{id:'builtin',baseURL:BUILTIN_URL,name:'Mock node',key:'mock-integration-key',enabledModels:['gpt-image-2','gpt-5.6']});
   await engine.execute('createTask',{kind:'single'});const id=engine.getState().tasks[0].id;
   await engine.execute('updateTask',{id,prompt:'蓝色小方块',params:{count:2}});
   await engine.execute('submitTask',{id});await engine.drain();
   const first=engine.getState().tasks[0].jobs[0];assert.equal(first.status,'completed');assert.equal(first.results.length,2);
   const saved=files.resolveResultPath(first.results[0].id)!;assert.equal((await sharp(await readFile(saved)).metadata()).format,'png');
   await engine.execute('useResult',{id,resultId:first.results[0].id});
   await engine.execute('updateTask',{id,params:{count:1}});await engine.execute('submitTask',{id});await engine.drain();
   assert.equal(engine.getState().tasks[0].jobs[1].status,'completed');
   await engine.execute('enhancePrompt',{id,mode:'translate'});
   assert.match(engine.getState().tasks[0].prompt,/small blue square/);
   await engine.execute('favoriteResult',{resultId:first.results[0].id});engine.stop();await store.close();
   store=new SQLiteStore(path.join(root,'data.sqlite'));const reopenedFiles=new FileService(root,{imageProcessor:processImageBuffer});await reopenedFiles.init();
   engine=new Engine({store,provider,credentials,output:reopenedFiles,references:reopenedFiles});await engine.init();await engine.drain();
   const restored=engine.getState().tasks[0];assert.equal(restored.jobs.length,2);assert.equal(restored.jobs[0].results[0].favorite,true);assert.equal(restored.referenceIds.length,1);
   assert.equal(calls.filter(x=>x.url.endsWith('/images/generations')).length,1);assert.equal(calls.filter(x=>x.url.endsWith('/images/edits')).length,1);
   assert.equal(calls.filter(x=>x.url.endsWith('/chat/completions')).length,1);
 } finally {engine?.stop();await store?.close();await provider.close();await rm(root,{recursive:true,force:true});}
});
