import { contextBridge, ipcRenderer } from 'electron';
import { ACTIONS, type Action, type AppState } from '../shared/types';
contextBridge.exposeInMainWorld('qingtu',{
  invoke:async(action:Action,payload?:Record<string,unknown>)=>{
    if(!ACTIONS.includes(action))throw new Error('不支持的操作');
    const result=await ipcRenderer.invoke('qingtu:command',action,payload??{});
    if(!result.ok)throw new Error(result.error||'操作失败');
    return result.value;
  },
  subscribe:(listener:(state:AppState)=>void)=>{
    if(typeof listener!=='function')throw new Error('无效的订阅');
    const callback=(_event:unknown,state:AppState)=>listener(state);
    ipcRenderer.on('qingtu:state',callback);
    return ()=>ipcRenderer.removeListener('qingtu:state',callback);
  },
});
