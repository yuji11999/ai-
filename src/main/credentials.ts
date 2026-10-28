import { mkdir, readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export class CredentialVault {
  private records: Record<string,string> = Object.create(null);
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private encryption: SecretEncryption) {}
  async init() {
    await mkdir(this.directory,{recursive:true});
    try {
      const raw=await readFile(path.join(this.directory,'credentials.json'),'utf8');
      if(raw.length>1024*1024) throw new Error('凭据文件过大');
      const data=JSON.parse(raw);
      if(!data || Array.isArray(data) || typeof data!=='object') throw new Error('凭据文件损坏');
      for(const [k,v] of Object.entries(data)) {
        this.validateID(k);
        if(typeof v!=='string'||v.length>65536) throw new Error('凭据文件损坏');
        this.records[k]=v;
      }
    } catch(e:any) { if(e.code!=='ENOENT') throw new Error('无法读取本地加密凭据，请检查数据目录'); }
  }
  private validateID(id:string) { if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('无效的供应商标识'); }
  async get(id:string):Promise<string|undefined> {
    this.validateID(id); await this.tail;
    if(!this.records[id])return undefined;
    if(!this.encryption.isEncryptionAvailable())throw new Error('当前系统无法解密保存的 Key');
    try{return this.encryption.decryptString(Buffer.from(this.records[id],'base64'));}
    catch{throw new Error('无法解密 Key，请在供应商设置中重新填写');}
  }
  async set(id:string,key:string) {
    this.validateID(id);
    if(typeof key!=='string'||!key.trim()||key.length>16384||/[\r\n\0]/.test(key))throw new Error('Key 格式无效');
    if(!this.encryption.isEncryptionAvailable())throw new Error('系统加密不可用，未保存 Key');
    const encrypted=this.encryption.encryptString(key.trim()).toString('base64');
    return this.mutate(next=>{next[id]=encrypted;});
  }
  async delete(id:string) {this.validateID(id);return this.mutate(next=>{delete next[id];});}
  private mutate(change:(next:Record<string,string>)=>void):Promise<void> {
    const operation=this.tail.then(async()=>{
      const next={...this.records};change(next);
      const temporary=path.join(this.directory,`credentials-${randomUUID()}.tmp`);
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}
      await rename(temporary,path.join(this.directory,'credentials.json'));
      this.records=next;
    });
    this.tail=operation.catch(()=>{});return operation;
  }
}
