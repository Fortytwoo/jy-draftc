const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('poc', {
  close: () => ipcRenderer.invoke('close-poc'),
  checkpoint: () => ipcRenderer.invoke('checkpoint-poc'),
  onEvent: callback => ipcRenderer.on('event', (_event, value) => callback(value))
});
