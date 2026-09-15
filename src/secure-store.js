// Where the refresh token lives.
//
// docs/roadmap/AUTH-FLOW.md's rule, kept as written: no token ever touches
// localStorage or sessionStorage. Those are plaintext files in the profile
// directory that any process running as the user can read, and in a renderer
// they are reachable by any script that gets in.
//
// The roadmap reaches for keytar. This uses Electron's own `safeStorage`
// instead, which wraps the same OS facilities keytar does — DPAPI on Windows,
// Keychain on macOS, libsecret on Linux — with two advantages that matter to
// this repo specifically: it is built into Electron, so it adds no NATIVE
// dependency to a build that BUILD.md already documents as fragile around
// native modules on Windows, and keytar itself is archived upstream.
//
// The ciphertext is written to one JSON file in userData. That file is useless
// on another machine and to another user account: the key never leaves the OS
// keystore, and encryptString on Windows binds the ciphertext to the user
// profile.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'auth-store.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    // Missing is the normal first-run case; corrupt is not, but the answer to
    // both is the same — an empty store, so the person signs in again. The
    // alternative is an app that cannot start because a cache file is damaged.
    return {};
  }
}

function writeAll(data) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written for this user only. On Windows the mode is largely advisory, but
  // on macOS and Linux it is what stops another account on the machine reading
  // the ciphertext at all.
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// Encryption may genuinely be unavailable — a Linux box with no keyring daemon
// is the real case. Refusing to store anything is the correct behaviour there:
// the person stays signed in for the session and signs in again next launch,
// which is a worse experience and not a plaintext credential on disk.
function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function get(key) {
  if (!available()) return null;

  const stored = readAll()[key];
  if (!stored) return null;

  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // Wrong machine, wrong user, or a rotated OS key. The value is gone either
    // way; drop it rather than leaving a permanently undecryptable blob behind.
    remove(key);
    return null;
  }
}

function set(key, value) {
  if (!available()) return false;
  if (typeof value !== 'string') throw new TypeError('secure-store holds strings only.');

  const data = readAll();
  data[key] = safeStorage.encryptString(value).toString('base64');
  writeAll(data);
  return true;
}

function remove(key) {
  const data = readAll();
  if (!(key in data)) return false;
  delete data[key];
  writeAll(data);
  return true;
}

// Only these two keys are ever accepted. The renderer names the key it wants,
// so without this an injected script could use the OS keystore as general
// storage — or, worse, read a key some later feature put there.
const ALLOWED = new Set(['refreshToken', 'lastEmail']);

function registerSecureStore(ipcMain) {
  ipcMain.handle('secure:get', (_e, key) => (ALLOWED.has(key) ? get(key) : null));
  ipcMain.handle('secure:set', (_e, key, value) => (ALLOWED.has(key) ? set(key, value) : false));
  ipcMain.handle('secure:delete', (_e, key) => (ALLOWED.has(key) ? remove(key) : false));
  ipcMain.handle('secure:available', () => available());
}

module.exports = { registerSecureStore, get, set, remove, available };
