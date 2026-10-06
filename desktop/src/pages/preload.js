// Preload for tab pages. Websites get nothing from it; only Buzz's own app
// pages receive an API, and the main process re-checks the caller on every call.
const { contextBridge, ipcRenderer } = require('electron');

const APP_PAGES = ['settings', 'history', 'downloads'];

if (location.protocol === 'buzz:' && APP_PAGES.includes(location.hostname)) {
  contextBridge.exposeInMainWorld('buzz', {
    call: (method, ...args) => ipcRenderer.invoke('internal:invoke', method, ...args),
    on: (name, listener) => {
      ipcRenderer.on('internal:event', (_event, eventName, data) => {
        if (eventName === name) listener(data);
      });
    },
  });
}
