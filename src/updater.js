const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

function setupAutoUpdater(mainWindow) {
  // Registered before the dev bail-out so the menubar button can say WHY it
  // did nothing: `npm start` has no app-update.yml to read. Returns the new
  // version or null — never the raw result, whose download promise cannot
  // cross IPC. removeHandler: a mac re-activation calls this again.
  ipcMain.removeHandler('updater:check');
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) throw new Error('Updates only work in the installed app');
    const r = await autoUpdater.checkForUpdates();
    return r?.isUpdateAvailable ? r.updateInfo.version : null;
  });

  // Don't run updates in development mode
  if (!app.isPackaged) {
    return;
  }

  // ponytail: an ad-hoc-signed mac build cannot install its own update
  // (Squirrel.Mac checks the signature), so on mac Help ▸ Check for updates
  // only reports the version. Drop this once identity/notarize are on.
  if (process.platform === 'darwin') {
    autoUpdater.autoDownload = false;
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

  ipcMain.removeHandler('updater:install');
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
