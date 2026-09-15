const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

function setupAutoUpdater(mainWindow) {
  // Don't run updates in development mode
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Function to check if release notes specify a security/critical update
  const isCriticalUpdate = (info) => {
    if (!info || !info.releaseNotes) return false;
    const notes = String(info.releaseNotes).toLowerCase();
    return notes.includes('[security]') || notes.includes('[critical]');
  };

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    mainWindow.webContents.send('updater:available', {
      version: info.version,
      critical: isCriticalUpdate(info),
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('App is up to date.');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('updater:progress', progressObj.percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    mainWindow.webContents.send('updater:ready', {
      version: info.version,
      critical: isCriticalUpdate(info),
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Updater error:', err);
    mainWindow.webContents.send('updater:error', err.message);
  });

  // Setup IPC Handlers
  ipcMain.handle('updater:check', async () => {
    return autoUpdater.checkForUpdatesAndNotify();
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  });

  // Check on startup
  autoUpdater.checkForUpdatesAndNotify();

  // Also check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 4 * 60 * 60 * 1000);
}

module.exports = { setupAutoUpdater };
