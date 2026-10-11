// Bridge for the Settings window. The renderer never sees the stored API key.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gstt', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  testKey: (key) => ipcRenderer.invoke('settings:test-key', key),
  clearKey: () => ipcRenderer.invoke('settings:clear-key'),
  close: () => ipcRenderer.invoke('settings:close'),
});
