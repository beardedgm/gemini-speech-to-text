// Bridge for the Settings window. The renderer never sees the stored API key.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gstt', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  testKey: (key) => ipcRenderer.invoke('settings:test-key', key),
  clearKey: () => ipcRenderer.invoke('settings:clear-key'),
  checkHotkey: (spec) => ipcRenderer.invoke('hotkey:check', spec),
  recordHotkey: () => ipcRenderer.invoke('hotkey:record'),
  cancelRecordHotkey: () => ipcRenderer.invoke('hotkey:cancel'),
  close: () => ipcRenderer.invoke('settings:close'),
  listMics: () => ipcRenderer.invoke('mics:list'),
  testMic: (mic) => ipcRenderer.invoke('mics:test', mic),
  testAllMics: () => ipcRenderer.invoke('mics:test-all'),
  onMicLevel: (fn) => ipcRenderer.on('mics:level', (_e, id, db) => fn(id, db)),
  onMicsChanged: (fn) => ipcRenderer.on('mics:changed', () => fn()),
});
