const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  getToken: () => ipcRenderer.invoke('token:get'),
  setToken: (t) => ipcRenderer.invoke('token:set', t),
  clearToken: () => ipcRenderer.invoke('token:clear'),
  openExternal: (u) => ipcRenderer.invoke('open:external', u),
  openEditor: (o) => ipcRenderer.invoke('editor:open', o),
  isDemo: () => ipcRenderer.invoke('demo'),
  platform: process.platform,
});
