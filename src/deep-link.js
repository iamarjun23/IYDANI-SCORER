// iydani:// links.
//
// Needed because two flows leave the app and have to come back to it: a
// Razorpay payment page and (later) a hosted OAuth sign-in, both of which open
// in the SYSTEM browser rather than in a window we control. That is not a
// stylistic choice — a payment page rendered inside our own BrowserWindow means
// the app can read the card form, which is exactly what a payment page must be
// able to rule out, and the same argument is why AUTH-FLOW.md sends OAuth to
// the real browser too.
//
// The two platforms deliver the link completely differently:
//
//   macOS   fires 'open-url' on the running app.
//   Windows RE-LAUNCHES the executable with the URL as an argument. The single
//           instance lock turns that second launch into a 'second-instance'
//           event on the first one — WITHOUT the lock, the link opens a whole
//           second copy of the app and the first one never hears about it.
//
// A link is UNTRUSTED INPUT. Anything on the machine can invoke iydani://, so
// what arrives here is a request from an unknown party, not an instruction:
// it is parsed, checked against a fixed list of routes, and handed to the
// renderer as a named event. It never becomes a navigation, a file path or a
// shell argument.

const { app } = require('electron');

const SCHEME = 'iydani';

// Every route the app will act on. A link naming anything else is dropped.
const ROUTES = new Set([
  'booking/success',
  'booking/cancel',
  'teacher/payouts/complete',
  'oauth/callback',
]);

function parse(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${SCHEME}:`) return null;

  // iydani://booking/success?x=1 puts "booking" in host and "/success" in
  // pathname; iydani:///booking/success puts it all in pathname. Both spellings
  // occur in the wild depending on who built the redirect, so normalise rather
  // than trusting one shape.
  const route = `${parsed.host}${parsed.pathname}`.replace(/^\/+|\/+$/g, '');
  if (!ROUTES.has(route)) return null;

  // Query values are echoed to the renderer as strings and nothing more. They
  // are identifiers to look up server-side — never a status to believe: a link
  // saying a payment succeeded proves nothing, only Razorpay's signed webhook
  // does.
  const params = {};
  for (const [key, value] of parsed.searchParams) {
    if (key.length <= 64 && value.length <= 512) params[key] = value;
  }

  return { route, params };
}

function install(getWindow) {
  if (process.defaultApp) {
    // In development the executable is electron.exe and the app is an argument
    // to it, so the protocol has to be registered against both or Windows
    // records a handler that launches a bare Electron with no app.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(SCHEME, process.execPath, [require('path').resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  function deliver(url) {
    const link = parse(url);
    if (!link) return;

    const win = getWindow();
    if (!win || win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('deeplink', link);
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliver(url);
  });

  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${SCHEME}://`));
    if (url) deliver(url);
    else {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
  });

  // A cold start FROM a link: the URL is in this process's own argv and no
  // event will ever fire for it.
  const initial = process.argv.find((arg) => arg.startsWith(`${SCHEME}://`));
  return initial ? parse(initial) : null;
}

module.exports = { install, parse, SCHEME, ROUTES };
