// The security boundary. Every function here is named and does one thing —
// `ipcRenderer` itself is never exposed, because exposing it hands the renderer
// every channel the main process will ever have, including ones added later by
// somebody who did not know this existed.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hamsleka', {
  platform: process.platform,
  versions: {
    app: '0.21.7',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Public deployment endpoints (Cognito pool, API URL, scores bucket). Read
  // from src/aws-config.json in the main process — the same file the CSP is
  // built from, so the renderer cannot be handed a host it is not allowed to
  // reach.
  awsConfig: () => ipcRenderer.invoke('config:aws'),

  // The OS keystore, for the refresh token and nothing else. The main process
  // enforces which keys are permitted (src/secure-store.js); this side only
  // passes the name through. Nothing here can read the whole store, and no key
  // outside that list resolves.
  secureStore: {
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key),
    available: () => ipcRenderer.invoke('secure:available'),
  },

  // iydani:// links coming back from the system browser after a payment.
  // `initial` covers the cold-start case, where the link is what launched the
  // app and no event will ever fire for it.
  deepLink: {
    initial: () => ipcRenderer.invoke('deeplink:initial'),
    on: (callback) => {
      const subscription = (_event, link) => callback(link);
      ipcRenderer.on('deeplink', subscription);
      return () => ipcRenderer.removeListener('deeplink', subscription);
    },
  },

  // The name a file was saved under, as chosen in the Save dialog — the
  // basename only. Fires for every download, exports included.
  onFileSaved: (callback) => {
    const subscription = (_event, name) => callback(name);
    ipcRenderer.on('file:saved', subscription);
    return () => ipcRenderer.removeListener('file:saved', subscription);
  },

  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onAvailable: (callback) => {
      const subscription = (_event, info) => callback(info);
      ipcRenderer.on('updater:available', subscription);
      return () => ipcRenderer.removeListener('updater:available', subscription);
    },
    onReady: (callback) => {
      const subscription = (_event, info) => callback(info);
      ipcRenderer.on('updater:ready', subscription);
      return () => ipcRenderer.removeListener('updater:ready', subscription);
    },
    onProgress: (callback) => {
      const subscription = (_event, percent) => callback(percent);
      ipcRenderer.on('updater:progress', subscription);
      return () => ipcRenderer.removeListener('updater:progress', subscription);
    },
    onError: (callback) => {
      const subscription = (_event, message) => callback(message);
      ipcRenderer.on('updater:error', subscription);
      return () => ipcRenderer.removeListener('updater:error', subscription);
    }
  }
});

