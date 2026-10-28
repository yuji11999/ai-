import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type GenerationService, type EngineSnapshot } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';
import { getModelInfo } from '../src/main/provider';
import { BUILTIN_URL } from '../src/shared/types';
import { FileService } from '../src/main/files';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MODEL = 'gpt-image-2';
function fixture() {
  const keys = new Map<string, string>();
  const calls: {baseURL:string;key:string}[] = [];
  const store = new MemoryStore();
  const service: GenerationService = {
    models: async () => [getModelInfo(MODEL, true)],
    generate: async input => { calls.push({baseURL:input.baseURL,key:input.key}); throw {outcome:'rejected',status:400}; },
    enhance: async () => '',
  };
  const engine = new Engine({store, provider:service, credentials:{get:async id=>keys.get(id),set:async(id,key)=>{keys.set(id,key);},delete:async id=>{keys.delete(id);}}, output:{stage:async()=>[],write:async()=>{throw new Error('unused');}}});
  return {engine, keys, calls, store, service};
}
async function savedReady(engine:Engine, baseURL=BUILTIN_URL, key='review-fake-old-key') {
  await engine.execute('testProvider',{id:'builtin',baseURL,key});
  await engine.execute('saveProvider',{id:'builtin',name:'Review',baseURL,key,enabledModels:[MODEL]});
}

test('review: retry never transmits a replacement credential to the historical provider origin', async () => {
  const {engine,calls}=fixture(); await engine.init(); await savedReady(engine);
  await engine.execute('createTask',{kind:'single'}); const id=engine.getState().tasks[0].id;
  await engine.execute('updateTask',{id,prompt:'Review test; no network.'});
  await engine.execute('submitTask',{id}); await engine.drain();
  assert.equal(calls.length,1); assert.equal(engine.getState().tasks[0].jobs[0].status,'failed');
  await savedReady(engine,'https://new-provider.example/v1','review-fake-new-key');
  await engine.execute('retryFailed',{id}).catch(()=>undefined); await engine.drain();
  assert.equal(calls.some(call=>call.baseURL===BUILTIN_URL&&call.key==='review-fake-new-key'),false,
    'new credential was sent to the old origin when retrying a historical job');
  engine.stop();
});

test('review: a replacement untested key cannot inherit verified connection', async () => {
  const {engine}=fixture(); await engine.init(); await savedReady(engine);
  await engine.execute('saveProvider',{id:'builtin',name:'Review',baseURL:BUILTIN_URL,key:'review-fake-not-tested',enabledModels:[MODEL]});
  assert.equal(engine.getState().providers[0].connection,'untested'); engine.stop();
});

test('review: crash between credential save and provider snapshot commit cannot pair new key with old origin', async () => {
  const {engine,store,keys,calls}=fixture();await engine.init();await savedReady(engine);
  await engine.execute('createTask',{kind:'single'});const id=engine.getState().tasks[0].id;
  await engine.execute('updateTask',{id,prompt:'Review test; no network.'});
  await engine.execute('submitTask',{id});await engine.drain();engine.stop();
  const beforeChange=(await store.load())!;
  await savedReady(engine,'https://new-provider.example/v1','review-fake-new-key');
  // A real process crash after vault persistence but before snapshot commit leaves exactly this durable pair.
  await store.save(beforeChange);
  const restarted=new Engine({store,credentials:{get:async key=>keys.get(key),set:async(id,key)=>{keys.set(id,key);},delete:async id=>{keys.delete(id);}},provider:{models:async()=>[getModelInfo(MODEL,true)],generate:async input=>{calls.push({baseURL:input.baseURL,key:input.key});throw{outcome:'rejected',status:400};},enhance:async()=>''},output:{stage:async()=>[],write:async()=>{throw 0;}}});
  await restarted.init();await restarted.execute('retryFailed',{id}).catch(()=>undefined);await restarted.drain();
  assert.equal(calls.some(call=>call.baseURL===BUILTIN_URL&&call.key==='review-fake-new-key'),false,
    'credential persistence and provider config commit are not crash-atomic');
  restarted.stop();
});

test('review: crashing a submitting job does not generate again on init', async () => {
  const {engine,store,calls}=fixture(); await engine.init(); await savedReady(engine);
  await engine.execute('createTask',{kind:'single'}); const id=engine.getState().tasks[0].id;
  await engine.execute('updateTask',{id,prompt:'Review test; no network.'});
  engine.stop(); await engine.execute('submitTask',{id});
  const snapshot=(await store.load()) as EngineSnapshot; snapshot.state.tasks[0].jobs[0].status='submitting';
  await store.save(snapshot);
  const restarted=new Engine({store,provider:{models:async()=>[],generate:async()=>{calls.push({baseURL:'unexpected',key:'unexpected'});return[];},enhance:async()=>''},credentials:{get:async()=> 'review-fake-old-key',set:async()=>{},delete:async()=>{}},output:{stage:async()=>[],write:async()=>{throw 0;}}});
  await restarted.init();await restarted.drain();
  assert.equal(restarted.getState().tasks[0].jobs[0].status,'unknown');assert.equal(calls.length,0);restarted.stop();
});

test('review: downloading can recover a blob written before its manifest commit', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'qingtu-review-'));
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+ioAAAAASUVORK5CYII=','base64');
  const options={download:async()=>image,imageProcessor:async()=>({bytes:image,thumbnail:image,mime:'image/png',width:1,height:1})};
  const context={taskId:'review-task',taskKind:'single' as const,jobId:'review-job',run:1,row:1,index:1,outputDirectory:'',naming:'{序号}_{日期}',format:'png' as const,createdAt:Date.now()};
  try {
    const files=new FileService(dir,options);await files.init();
    const [source]=await files.stage([{url:'https://images.example/output.png'}],context);
    // Reproduce process exit immediately after download blob write, before asset.file + manifest persist.
    await writeFile(path.join(dir,'assets',`${source.id}.bin`),image,{flag:'wx'});
    const restarted=new FileService(dir,options);await restarted.init();
    const result=await restarted.write(source,context);
    assert.equal(result.id,source.id);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review: enhancement uses the chosen text provider, protects newer prompt and never falls back after deletion', async () => {
  const {engine,service}=fixture();
  service.models=async()=>[getModelInfo(MODEL,true),{...getModelInfo('gpt-5.6',true),text:true}];
  const enhanced: {baseURL:string;key:string;model?:string;prompt:string}[]=[];
  let release!: (value:string)=>void;
  service.enhance=async input=>{enhanced.push(input);return new Promise<string>(resolve=>{release=resolve;});};
  await engine.init();await savedReady(engine);
  const baseURL='https://chosen-text-provider.example/v1',key='review-fake-text-only-key';
  await engine.execute('testProvider',{baseURL,key});
  await engine.execute('saveProvider',{name:'Chosen text',baseURL,key,enabledModels:['gpt-5.6']});
  const textProviderId=engine.getState().providers.find(provider=>provider.baseURL===baseURL)!.id;
  await engine.execute('saveSettings',{textProviderId,textModel:'gpt-5.6'});
  await engine.execute('createTask',{kind:'single'});const id=engine.getState().tasks[0].id;
  await engine.execute('updateTask',{id,prompt:'original prompt'});
  const pending=engine.execute('enhancePrompt',{id,mode:'optimize'});
  for(let i=0;i<300&&!enhanced.length;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(enhanced.length,1);assert.equal(enhanced[0].baseURL,baseURL);assert.equal(enhanced[0].key,key);assert.equal(enhanced[0].model,'gpt-5.6');
  await engine.execute('updateTask',{id,prompt:'newer prompt'});
  release('stale enhanced prompt');await assert.rejects(pending);
  assert.equal(engine.getState().tasks[0].prompt,'newer prompt');
  await engine.execute('deleteProvider',{id:textProviderId});
  await assert.rejects(engine.execute('enhancePrompt',{id,mode:'translate'}));
  assert.equal(enhanced.length,1,'deleted text provider must not fall back to the generation provider');engine.stop();
});
