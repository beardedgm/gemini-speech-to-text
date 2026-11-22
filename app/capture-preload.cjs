// Bridge for the hidden capture window (app/capture.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  // Commands from the main process: { type, ... }.
  onCommand: (fn) => ipcRenderer.on('cap:command', (_e, cmd) => fn(cmd)),
  // Events to the main process: devices, opened, failed, chunk, stopped, level.
  send: (msg) => ipcRenderer.send('cap:event', msg),
  chunk: (session, bytes) => ipcRenderer.send('cap:chunk', session, bytes),
});
