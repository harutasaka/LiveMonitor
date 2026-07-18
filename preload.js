const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getStreamers: () => ipcRenderer.invoke('get-streamers'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSettings: (data) => ipcRenderer.invoke('set-settings', data),
    addStreamer: (data) => ipcRenderer.invoke('add-streamer', data),
    removeStreamer: (id) => ipcRenderer.invoke('remove-streamer', id),
    openUrl: (url) => ipcRenderer.send('open-url', url),
    windowControl: (action) => ipcRenderer.send('window-control', action),
    onStatusUpdate: (callback) => ipcRenderer.on('status-updated', (event, data) => callback(data)),
    onTopStatus: (callback) => ipcRenderer.on('top-status', (event, isTop) => callback(isTop)),
    removeStatusListener: () => ipcRenderer.removeAllListeners('status-updated')
});