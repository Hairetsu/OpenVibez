import { contextBridge, ipcRenderer } from 'electron';
import type { OpenVibezApi } from './types';

const api: OpenVibezApi = {
  provider: {
    list: () => ipcRenderer.invoke('provider:list'),
    create: (input) => ipcRenderer.invoke('provider:create', input),
    saveSecret: (input) => ipcRenderer.invoke('provider:saveSecret', input),
    testConnection: (input) => ipcRenderer.invoke('provider:testConnection', input),
    startSubscriptionLogin: (input) => ipcRenderer.invoke('provider:startSubscriptionLogin', input),
    getSubscriptionLoginState: () => ipcRenderer.invoke('provider:getSubscriptionLoginState'),
    listModels: (input) => ipcRenderer.invoke('provider:listModels', input),
    refreshModels: (input) => ipcRenderer.invoke('provider:refreshModels', input)
  },
  session: {
    create: (input) => ipcRenderer.invoke('session:create', input),
    list: () => ipcRenderer.invoke('session:list'),
    archive: (input) => ipcRenderer.invoke('session:archive', input)
  },
  message: {
    send: (input) => ipcRenderer.invoke('message:send', input),
    cancel: (input) => ipcRenderer.invoke('message:cancel', input),
    list: (input) => ipcRenderer.invoke('message:list', input),
    onStreamEvent: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof handler>[0]) => {
        handler(payload);
      };

      ipcRenderer.on('message:stream-event', listener);
      return () => {
        ipcRenderer.removeListener('message:stream-event', listener);
      };
    }
  },
  workspace: {
    add: (input) => ipcRenderer.invoke('workspace:add', input),
    list: () => ipcRenderer.invoke('workspace:list')
  },
  settings: {
    get: (input) => ipcRenderer.invoke('settings:get', input),
    set: (input) => ipcRenderer.invoke('settings:set', input)
  },
  usage: {
    summary: (input) => ipcRenderer.invoke('usage:summary', input)
  },
  system: {
    openExternal: (input) => ipcRenderer.invoke('system:openExternal', input)
  }
};

contextBridge.exposeInMainWorld('openvibez', api);
