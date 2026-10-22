const { app, BrowserWindow, ipcMain, Menu, net, protocol, screen, session, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupAutoUpdater } = require('./updater');
const { registerSecureStore } = require('./secure-store');
const deepLink = require('./deep-link');
const awsConfig = require('./aws-config.json');

const isDev = !app.isPackaged;

// The window, kept so a deep link arriving from the OS has something to deliver
// to. There is only ever one.
let mainWindow = null;

// Note samples are served over their own scheme instead of being read with
// fetch() from file://, which Chromium refuses. Declaring it standard+secure
// also keeps it out of the way of the CSP's 'self'.
protocol.registerSchemesAsPrivileged([
  { scheme: 'dng', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Only `<instrument folder>/<name>.wav` inside renderer/samples ever resolves —
// exactly two path segments, each matched against a strict pattern (no dots in
// the folder, so no `..`), and the joined path re-checked to sit directly in a
// folder of SAMPLE_DIR, so a crafted URL cannot walk out of it.
const SAMPLE_DIR = path.join(__dirname, 'renderer', 'samples');

function registerSampleProtocol() {
  protocol.handle('dng', (request) => {
    let parts;
    try {
      parts = decodeURIComponent(new URL(request.url).pathname).split('/').filter(Boolean);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const [dir, name] = parts;
    if (parts.length !== 2 || !/^[a-z0-9-]+$/.test(dir) || !/^[A-Za-z0-9_-]+\.wav$/.test(name)) {
      return new Response('not found', { status: 404 });
    }
    const file = path.join(SAMPLE_DIR, dir, name);
    if (path.dirname(path.dirname(file)) !== SAMPLE_DIR) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

if (isDev) {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron')
  });
}


function createWindow() {
  // What the screen can actually show. 1600x1000 is larger than the whole
  // desktop on most laptops — a 1920x1080 panel at the 125% or 150% scaling
  // Windows picks for it is 1536x864 or 1280x720 — and a window opened past
  // the edge of the screen has its right-hand controls and its piano off it.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = mainWindow = new BrowserWindow({
    // The sheet is a 21 cm page — 794 CSS px at 96 dpi — and the chrome around
    // it is a 176 px tool rail plus the 460 px section rail. 1440 left the
    // staff being squeezed below true size the moment the roll widened the
    // right-hand side, so the default window is sized to hold the page at 100%
    // zoom with both rails open rather than to a round number.
    width: Math.min(1600, area.width),
    height: Math.min(1000, area.height),
    // Small enough to fit a 1280x720 desktop with room to move. The layout
    // gives way in steps under 1720px — see "smaller windows" in index.html.
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#191919',
    title: 'IYDANI SCORER',
    // build/icon.png is what electron-builder stamps onto the EXE, but it is
    // NOT inside the asar (the files list is src/** only), so the window icon
    // has to point at the copy that ships with the renderer.
    icon: path.join(__dirname, 'renderer', 'brand', 'iydani-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      webSecurity: true,
    },
  });

  // A screen with no room to spare gets all of it.
  if (area.width < 1600 || area.height < 1000) win.maximize();

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const here = new URL(win.webContents.getURL());
    if (target.origin !== here.origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // DevTools is opened by hand in dev, not at launch. The application menu is
  // null, so the accelerator Electron's default menu would supply is gone too
  // and has to be bound here.
  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (key === 'f12' || (key === 'i' && input.shift && (input.control || input.meta))) {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  setupAutoUpdater(win);
}

// Web MIDI needs an explicit grant. Chromium asks for it the first time
// navigator.requestMIDIAccess() runs; with no handler installed Electron
// denies, and the renderer sees a plain rejection it cannot distinguish from
// "no device".
//
// The permission NAME is 'midiSysex', even for a sysex-free request. This is
// not what it looks like. Chromium routes every requestMIDIAccess() through
// the MIDI_SYSEX permission type, so a renderer asking with sysex:false still
// arrives here as 'midiSysex' — measured on Electron 33.4.11: granting only
// 'midi' rejects with NotAllowedError and the input list comes back EMPTY,
// which is exactly the "connected keyboard, no device in the dock" report this
// replaced. Nothing ever asks for plain 'midi', so that entry was dead and the
// feature could not work.
//
// Granting it does NOT hand the renderer sysex. Whether sysex is live is
// decided by the OPTION on the request, not by this name: with the permission
// granted, sysex:false yields sysexEnabled === false and sysex:true yields
// true. midi-input.js calls WebMidi.enable({ sysex: false }) and is the only
// caller, so the access object cannot carry sysex and an instrument's memory
// stays unreachable — the rule this used to enforce by denial is now enforced
// at the request. Keep that option false; it is the whole guard.
//
// Electron gives the handler no sysex flag in `details`, so the distinction
// cannot be made here — which is why it is made in the renderer instead.
function applyPermissions() {
  const ALLOWED = new Set(['midiSysex', 'media']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

// The backend hosts the renderer is allowed to reach, derived from
// src/aws-config.json rather than typed here. Every entry is a specific host:
// no wildcard, and nothing is added for a field that has not been filled in, so
// an unconfigured app can reach exactly what it could before any of this
// existed. Cognito's host is included whenever a region is set because it is
// where sign-in goes, and it is a fixed AWS endpoint rather than anything of
// ours.
function backendOrigins() {
  const origins = [];

  if (awsConfig.region) {
    origins.push(`https://cognito-idp.${awsConfig.region}.amazonaws.com`);
  }

  for (const url of [awsConfig.apiUrl]) {
    if (!url) continue;
    try {
      origins.push(new URL(url).origin);
    } catch {
      console.warn('[csp] apiUrl in aws-config.json is not a URL:', url);
    }
  }

  // Scores are PUT and GET straight to S3 through presigned URLs, so the bucket
  // is a connect target in its own right — the API never carries the file body.
  if (awsConfig.scoresBucketHost) {
    origins.push(`https://${awsConfig.scoresBucketHost}`);
  }

  return origins;
}

function applyCsp() {
  const backend = backendOrigins().join(' ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: file: blob:",
            `connect-src 'self' dng: https://fonts.googleapis.com https://fonts.gstatic.com https://clients3.google.com${backend ? ' ' + backend : ''}`,
            "media-src 'self' blob: dng:",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
        ],
      },
    });
  });
}

// Windows delivers an iydani:// link by launching the executable again. Without
// this lock that second launch is a second copy of the app, and the running one
// — the one holding the session the link is about — never hears anything.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerSampleProtocol();
    applyCsp();
    applyPermissions();
    registerSecureStore(ipcMain);

    // Public deployment endpoints, handed to the renderer through the preload
    // bridge. It is the same file the CSP above is built from, so the app
    // cannot be allowed to reach a host it has not been told about.
    ipcMain.handle('config:aws', () => ({
      region: awsConfig.region || '',
      userPoolId: awsConfig.userPoolId || '',
      userPoolClientId: awsConfig.userPoolClientId || '',
      apiUrl: awsConfig.apiUrl || '',
      scoresBucketHost: awsConfig.scoresBucketHost || '',
    }));

    // Electron already shows the Save dialog for an <a download>; this only
    // reports back the NAME chosen there, so the tab can show it. The basename
    // and nothing else — the renderer has no use for where on disk it went.
    session.defaultSession.on('will-download', (_event, item, contents) => {
      item.once('done', (_e, result) => {
        if (result === 'completed' && !contents.isDestroyed()) {
          contents.send('file:saved', path.basename(item.getSavePath()));
        }
      });
    });

    Menu.setApplicationMenu(null);
    createWindow();

    // A link the app was STARTED by has no event to fire — it is already in
    // argv. Held until the renderer says it is listening, since a message sent
    // now would arrive before anything is there to receive it.
    const cold = deepLink.install(() => mainWindow);
    ipcMain.handle('deeplink:initial', () => cold);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
