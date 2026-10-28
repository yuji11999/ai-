import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialVault } from '../src/main/credentials';
const encryption={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from([...s].reverse().join('')),decryptString:(b:Buffer)=>[...b.toString()].reverse().join('')};
test('vault serializes writes, persists encrypted values and does not expose keys in JSON',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qingtu-vault-'));
 try{const v=new CredentialVault(dir,encryption);await v.init();await Promise.all([v.set('one','mock-secret-one'),v.set('two','mock-secret-two')]);assert.equal(await v.get('one'),'mock-secret-one');assert.equal((await readFile(path.join(dir,'credentials.json'),'utf8')).includes('mock-secret'),false);const r=new CredentialVault(dir,encryption);await r.init();assert.equal(await r.get('two'),'mock-secret-two');await r.delete('one');assert.equal(await r.get('one'),undefined);await assert.rejects(r.set('../bad','x'));}finally{await rm(dir,{recursive:true,force:true});}
});
test('vault refuses plaintext fallback when encryption unavailable',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qingtu-vault-'));
 try{const v=new CredentialVault(dir,{...encryption,isEncryptionAvailable:()=>false});await v.init();await assert.rejects(v.set('test','mock-secret'),/系统加密不可用/);}finally{await rm(dir,{recursive:true,force:true});}
});
