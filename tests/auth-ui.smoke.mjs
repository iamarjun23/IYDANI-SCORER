// A live check of the account layer, driven through the running app.
//
//   npx electron . --remote-debugging-port=9335
//   node tests/auth-ui.smoke.mjs 9335
//
// Everything else about accounts needs AWS to be deployed before it can be
// exercised at all, which is exactly why this exists: it covers the half that
// is true on any machine, deployed or not, and that half is where the failures
// are silent. A preload bridge that was never exposed, a dialog whose markup
// does not match the ids the module looks up, a header button that never
// repaints, an unconfigured build that throws on startup instead of carrying on
// offline — none of those raise anything a person would see, and all four are
// exactly what a first deployment would be blamed for.
//
// It runs against an UNCONFIGURED build (src/aws-config.json with empty
// endpoints), because that is the state the repo ships in and the state the app
// must survive.

const port = process.argv[2] || '9335';
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const target = targets.find(t => t.type === 'page' && t.url.includes('/src/renderer/index.html'));
if (!target) throw new Error('No Electron renderer target found — is the app running?');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true });
  socket.addEventListener('error', rej, { once: true });
});

let messageId = 0;
function command(method, params = {}) {
  const id = ++messageId;
  return new Promise((res, rej) => {
    const onMessage = event => {
      const reply = JSON.parse(event.data);
      if (reply.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (reply.error) rej(new Error(reply.error.message));
      else if (reply.result.exceptionDetails) {
        rej(new Error(reply.result.exceptionDetails.exception?.description
          || reply.result.exceptionDetails.text));
      } else res(reply.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = async expression => {
  const { result } = await command('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  return result.value;
};

const wait = ms => new Promise(r => { setTimeout(r, ms); });

// init() wires the account button and paints it from initAccount(), which runs
// last and is deliberately not awaited (it makes a network call). A check that
// starts before that lands sees an unwired button and blames the wiring — so
// wait for the app to say it is ready, and start from a closed dialog however
// the previous run left things.
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = await evaluate(`(() => {
    const btn = document.getElementById('profileBtn');
    const overlay = document.getElementById('authOverlay');
    if (!btn || !overlay) return false;
    overlay.hidden = true;
    return btn.title === 'Sign in';
  })()`);
  if (ready) break;
  await wait(250);
}

let checks = 0;
const is = (a, b, m) => {
  checks += 1;
  if (a !== b) throw new Error(`${m}\n  expected ${b}\n  actual   ${a}`);
};
const ok = (v, m) => { checks += 1; if (!v) throw new Error(m); };

// ---- the preload bridge ---------------------------------------------------
// Named functions only. If `secureStore` is missing here the renderer has no
// way to persist a session at all, and the app would simply sign you out at
// every launch with nothing on screen explaining why.

const bridge = await evaluate(`(() => {
  const b = window.hamsleka;
  return {
    exists: Boolean(b),
    hasSecureStore: typeof b?.secureStore?.set === 'function'
      && typeof b?.secureStore?.get === 'function'
      && typeof b?.secureStore?.delete === 'function',
    hasAwsConfig: typeof b?.awsConfig === 'function',
    hasDeepLink: typeof b?.deepLink?.on === 'function',
    // The thing the boundary exists to prevent.
    leaksIpc: 'ipcRenderer' in window || typeof b?.ipcRenderer !== 'undefined',
  };
})()`);

ok(bridge.exists, 'window.hamsleka is missing — the preload never ran.');
ok(bridge.hasSecureStore, 'secureStore is not exposed on the bridge.');
ok(bridge.hasAwsConfig, 'awsConfig() is not exposed on the bridge.');
ok(bridge.hasDeepLink, 'deepLink.on() is not exposed on the bridge.');
is(bridge.leaksIpc, false, 'ipcRenderer is reachable from the renderer.');

// ---- the OS keystore round trip -------------------------------------------
// safeStorage encrypts with a key that never leaves the OS keystore, so this
// proves the whole path: renderer -> preload -> main -> DPAPI/Keychain and
// back. A machine with no keyring (a bare Linux box) reports unavailable, and
// that is a pass too — the contract is that it never silently writes plaintext.

const keystore = await evaluate(`(async () => {
  const store = window.hamsleka.secureStore;
  const available = await store.available();
  if (!available) return { available: false };

  const wrote = await store.set('refreshToken', 'smoke-test-value');
  const read = await store.get('refreshToken');
  await store.delete('refreshToken');
  const afterDelete = await store.get('refreshToken');

  // The allowlist in src/secure-store.js: a key outside it must not resolve,
  // or the keystore becomes general-purpose storage for anything in the page.
  const rejected = await store.set('somethingElse', 'nope');

  return { available: true, wrote, read, afterDelete, rejected };
})()`);

if (keystore.available) {
  is(keystore.wrote, true, 'secureStore.set() refused a permitted key.');
  is(keystore.read, 'smoke-test-value', 'secureStore did not return what it stored.');
  is(keystore.afterDelete, null, 'secureStore.delete() left the value behind.');
  is(keystore.rejected, false, 'secureStore accepted a key outside the allowlist.');
} else {
  checks += 1;
  console.log('  (no OS keystore on this machine — round trip skipped, which is a valid state)');
}

// ---- an unconfigured build stays usable -----------------------------------

const config = await evaluate(`(async () => {
  const auth = await import('./auth.js');
  const c = await auth.awsConfig();
  return { configured: await auth.isConfigured(), region: c.region, apiUrl: c.apiUrl };
})()`);

is(config.configured, false,
  'This build reports a configured backend — run this against the shipped, empty aws-config.json.');
is(typeof config.region, 'string', 'awsConfig() did not return a region string.');

// A Cognito call with nothing configured must fail as a NAMED condition rather
// than as a TypeError from somewhere inside fetch(), or the dialog cannot tell
// "no backend here" from "wrong password".
const unconfigured = await evaluate(`(async () => {
  const { signIn } = await import('./auth.js');
  try {
    await signIn({ email: 'a@b.com', password: 'Passw0rd!' });
    return { threw: false };
  } catch (err) {
    return { threw: true, code: err.code, message: err.message };
  }
})()`);

is(unconfigured.threw, true, 'signIn() resolved with no backend configured.');
is(unconfigured.code, 'NotConfigured', 'signIn() failed with the wrong code.');
ok(/configured/i.test(unconfigured.message), 'The unconfigured message does not say so in words.');

// ---- the dialog -----------------------------------------------------------

const before = await evaluate(`(() => {
  const btn = document.getElementById('profileBtn');
  return {
    overlayHidden: document.getElementById('authOverlay').hidden,
    signedInClass: btn.classList.contains('signed-in'),
    title: btn.title,
  };
})()`);

is(before.overlayHidden, true, 'The account dialog is open before anything asked for it.');
is(before.signedInClass, false, 'The header button claims a session with nobody signed in.');
is(before.title, 'Sign in', 'The header button does not offer to sign in.');

await evaluate(`document.getElementById('profileBtn').click()`);
await wait(200);

const opened = await evaluate(`(() => {
  const overlay = document.getElementById('authOverlay');
  const body = document.getElementById('authBody');
  return {
    hidden: overlay.hidden,
    title: document.getElementById('authTitle').textContent,
    hasEmail: Boolean(body.querySelector('#authEmail')),
    hasPassword: Boolean(body.querySelector('#authPassword')),
    passwordIsMasked: body.querySelector('#authPassword')?.type === 'password',
    hasSubmit: Boolean(body.querySelector('#authSubmit')),
    links: [...body.querySelectorAll('[data-view]')].map(el => el.dataset.view),
    // The unconfigured build should SAY it is unconfigured rather than present
    // a form that cannot possibly work.
    note: body.querySelector('.auth-note')?.textContent || '',
  };
})()`);

is(opened.hidden, false, 'Clicking the account button did not open the dialog.');
is(opened.title, 'Sign in', 'The dialog opened on the wrong view.');
ok(opened.hasEmail && opened.hasPassword, 'The sign-in view is missing its fields.');
is(opened.passwordIsMasked, true, 'The password field is not masked.');
ok(opened.hasSubmit, 'The sign-in view has no submit button.');
ok(opened.links.includes('register'), 'No way through to registration.');
ok(opened.links.includes('forgot'), 'No way through to a password reset.');
ok(/configured/i.test(opened.note), 'An unconfigured build does not say so in the dialog.');

// Moving between views has to carry the email across, or somebody who mistypes
// their password retypes their address to reach the reset form.
await evaluate(`(() => {
  document.getElementById('authEmail').value = 'ravi@example.com';
  document.querySelector('[data-view="forgot"]').click();
})()`);
await wait(120);

const carried = await evaluate(`(() => ({
  title: document.getElementById('authTitle').textContent,
  email: document.getElementById('authEmail')?.value || '',
}))()`);

is(carried.title, 'Reset your password', 'The forgot-password link did not change the view.');
is(carried.email, 'ravi@example.com', 'The email was not carried between views.');

// Esc closes, and — the part that matters — the keystroke must not reach the
// staff behind. A dialog that lets typing through writes notes onto the score
// while somebody enters a password.
const notesBefore = await evaluate(`(async () => (await import('./state.js')).state.notes.length`
  + `)()`);

await command('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a',
});
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
await wait(120);

const notesAfter = await evaluate(`(async () => (await import('./state.js')).state.notes.length)()`);
is(notesAfter, notesBefore, 'A letter typed over the dialog wrote a note onto the staff.');

await command('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
});
await command('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
});
await wait(150);

is(await evaluate(`document.getElementById('authOverlay').hidden`), true, 'Esc did not close the dialog.');

// ---- the header button follows the session --------------------------------
// Painted from an 'auth:changed' event rather than by whoever changed the
// session, so a token expiring in the background repaints it too.

await evaluate(`(async () => {
  const { state } = await import('./state.js');
  state.user = { id: 'u1', email: 'ravi@example.com', displayName: 'Ravi Kumar', role: 'TEACHER' };
  document.dispatchEvent(new CustomEvent('auth:changed', { detail: { user: state.user } }));
})()`);
await wait(150);

const painted = await evaluate(`(() => {
  const btn = document.getElementById('profileBtn');
  return { cls: btn.classList.contains('signed-in'), text: btn.textContent.trim(), title: btn.title };
})()`);

is(painted.cls, true, 'The header button did not mark itself signed in.');
is(painted.text, 'R', 'The header button does not show the initial.');
ok(painted.title.includes('ravi@example.com'), 'The header button does not name the account.');

// And the dialog shows the account rather than a sign-in form.
await evaluate(`document.getElementById('profileBtn').click()`);
await wait(200);

const account = await evaluate(`(() => {
  const body = document.getElementById('authBody');
  return {
    title: document.getElementById('authTitle').textContent,
    name: body.querySelector('.auth-who b')?.textContent || '',
    role: body.querySelector('.auth-role')?.textContent || '',
    hasSignOut: Boolean(body.querySelector('#authSignOut')),
    hasPasswordField: Boolean(body.querySelector('#authPassword')),
  };
})()`);

is(account.title, 'Your account', 'The dialog did not switch to the signed-in view.');
is(account.name, 'Ravi Kumar', 'The signed-in view does not name the account.');
ok(/teacher/i.test(account.role), 'The signed-in view does not report the role.');
ok(account.hasSignOut, 'The signed-in view offers no way out.');
is(account.hasPasswordField, false, 'The signed-in view still shows a password field.');

// Put the app back as it was found.
await evaluate(`(async () => {
  const { state } = await import('./state.js');
  state.user = null;
  document.dispatchEvent(new CustomEvent('auth:changed', { detail: { user: null } }));
  document.getElementById('authOverlay').hidden = true;
})()`);

console.log(`auth-ui: ${checks} checks passed`);
socket.close();
