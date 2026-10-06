const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'toast', 'focus-address', 'open-find', 'close-find', 'find-result', 'backdrop', 'close-suggest'];

contextBridge.exposeInMainWorld('buzz', {
  send: (action, payload) => ipcRenderer.send('ui:action', action, payload),
  suggest: (text) => ipcRenderer.invoke('ui:suggest', text),
  on: (channel, listener) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on('ui:' + channel, (_event, data) => listener(data));
  },
});
