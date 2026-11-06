const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { execFile, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { app, ipcMain, net } = require('electron');

const MAC = process.platform === 'darwin';
let win = null;

// Re-activation on a Mac hands us a new window; an update already under way
// must report to that one, not the window that was closed.
const send = (channel, value) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
};

// Function to check if release notes specify a security/critical update
const isCriticalUpdate = (info) => {
  if (!info || !info.releaseNotes) return false;
  const notes = String(info.releaseNotes).toLowerCase();
  return notes.includes('[security]') || notes.includes('[critical]');
};

// ---- macOS ----------------------------------------------------------------
// Squirrel.Mac, which electron-updater drives on a Mac, installs only an
// update signed by the same Developer ID as the running app, and this build
// is ad-hoc signed (electron-builder.yml). So on a Mac electron-updater only
// CHECKS, and the download and the swap are done here, through the same IPC
// events Windows sends, so updater-ui.js cannot tell the two apart. A file the
// app downloads itself carries no quarantine flag, which is why the new copy
// opens without the Privacy & Security prompt the first install needed.
// ponytail: delete this block once identity/notarize are on; Squirrel does it.
let macReady = null; // { next: unpacked new .app, version }
let macBusy = false;

// /Applications/IYDANI.app, from .../IYDANI.app/Contents/MacOS/IYDANI
const bundlePath = () => path.resolve(app.getPath('exe'), '../../..');

// The repository the updater checks, from the app-update.yml electron-builder
// wrote out of electron-builder.yml's publish block, so it is named once.
function releaseRepo() {
  const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  const key = (k) => yml.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm'))?.[1];
  return `${key('owner')}/${key('repo')}`;
}

async function macDownload(info) {
  if (macBusy || macReady?.version === info.version) return;
  macBusy = true;
  try {
    const bundle = bundlePath();
    // Opened from the .dmg, or from Downloads, macOS runs a read-only copy
    // (App Translocation) and there is nothing here to replace.
    if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
      throw new Error('Move IYDANI into Applications to get updates');
    }
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    } catch {
      throw new Error(`No permission to replace the app in ${path.dirname(bundle)}`);
    }

    const file = (info.files || []).find((f) => f.url.endsWith(`-mac-${process.arch}.zip`));
    if (!file) throw new Error(`Version ${info.version} has no Mac ${process.arch} download`);
    const base = `https://github.com/${releaseRepo()}/releases/download/v${info.version}/`;
    const res = await net.fetch(new URL(file.url, base).href);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iydani-update-'));
    const zip = path.join(dir, 'update.zip');
    const out = fs.createWriteStream(zip);
    const hash = crypto.createHash('sha512');
    const total = Number(res.headers.get('content-length')) || file.size || 0;
    let got = 0;
    let shown = -1;
    send('updater:progress', 0);
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      const pct = total ? Math.floor((got * 100) / total) : 0;
      if (pct !== shown) send('updater:progress', (shown = pct));
    }
    await new Promise((ok, fail) => out.on('error', fail).end(ok));
    // latest-mac.yml carries the zip's sha512: a cut-off or altered download
    // is refused here rather than swapped in over a working app.
    if (hash.digest('base64') !== file.sha512) throw new Error('The downloaded update is damaged');

    await new Promise((ok, fail) =>
      execFile('ditto', ['-x', '-k', zip, dir], (err) => (err ? fail(err) : ok())));
    const name = fs.readdirSync(dir).find((f) => f.endsWith('.app'));
    if (!name) throw new Error('The downloaded update has no app in it');

    macReady = { next: path.join(dir, name), version: info.version };
    send('updater:ready', { version: info.version, critical: isCriticalUpdate(info) });
  } catch (err) {
    console.error('Updater error:', err);
    send('updater:error', err.message);
  } finally {
    macBusy = false;
  }
}

// The swap cannot happen while the app runs, so a detached shell waits for
// this process to exit, moves the old .app aside, moves the new one in (and
// the old one back if that fails), then reopens it when asked to.
const SWAP = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
rm -rf "$2.old"
mv "$2" "$2.old" || exit 1
if mv "$3" "$2"; then rm -rf "$2.old"; else mv "$2.old" "$2"; exit 1; fi
xattr -dr com.apple.quarantine "$2" 2>/dev/null
rm -rf "$(dirname "$3")"
if [ "$4" = 1 ]; then open "$2"; fi
`;

function macInstall(relaunch) {
  if (!macReady) return false;
  const { next } = macReady;
  macReady = null;
  spawn('/bin/sh', ['-c', SWAP, 'sh', String(process.pid), bundlePath(), next, relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  return true;
}

// Windows' autoInstallOnAppQuit: a downloaded update goes in when the app is
// closed, whether or not Restart was pressed.
if (MAC) app.on('before-quit', () => macInstall(false));

function setupAutoUpdater(mainWindow) {
  win = mainWindow;

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

  // On a Mac electron-updater only checks; macDownload() does the rest.
  autoUpdater.autoDownload = !MAC;
  autoUpdater.autoInstallOnAppQuit = !MAC;

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    send('updater:available', {
      version: info.version,
      critical: isCriticalUpdate(info),
    });
    if (MAC) macDownload(info);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('App is up to date.');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    send('updater:progress', progressObj.percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    send('updater:ready', {
      version: info.version,
      critical: isCriticalUpdate(info),
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Updater error:', err);
    send('updater:error', err.message);
  });

  ipcMain.removeHandler('updater:install');
  ipcMain.handle('updater:install', () => {
    if (!MAC) return autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
    if (macInstall(true)) app.quit();
  });

  // Check on startup
  autoUpdater.checkForUpdatesAndNotify();

  // Also check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 4 * 60 * 60 * 1000);
}

module.exports = { setupAutoUpdater };
