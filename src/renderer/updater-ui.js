// The menubar's update button. electron-updater (src/updater.js) checks on
// launch and every 4 hours and downloads in the background on its own; this
// says so, and lets you ask NOW. Idle it reads "Check for updates"; a click
// asks GitHub, then it is a progress pill while it downloads and an accent
// "Update ready" once it has landed — click that for Restart now / Later.
// Later costs nothing: autoInstallOnAppQuit installs it the next time the app
// is closed.
//
// A release whose notes carry [critical] or [security] still gets the
// blocking card instead: that is the one case where "later" is not allowed.

import { show, hide, pop } from './popover.js';

let updater, chip, text, bar;
let version = '';
let settle;

// A passing message ("Up to date") that falls back to idle on its own.
function say(st, label, title = '') {
  clearTimeout(settle);
  chip.dataset.state = st;
  text.textContent = label;
  chip.title = title;
}

const idle = () => say('idle', 'Check for updates', 'Check GitHub for a newer version');
const brief = (st, label, title) => { say(st, label, title); settle = setTimeout(idle, 4000); };

export function initUpdater() {
  updater = window.hamsleka?.updater;
  chip = document.getElementById('updChip');
  if (!updater || !chip) return;
  text = chip.querySelector('.upd-text');
  bar = chip.querySelector('.upd-bar i');
  chip.hidden = false;
  idle();

  const downloading = (pct) => {
    if (chip.dataset.state === 'ready') return;
    say('downloading', `Update ${Math.round(pct)}%`, `Downloading version ${version}`);
    bar.style.width = `${pct}%`;
  };

  updater.onAvailable((info) => { version = info.version; downloading(0); });
  updater.onProgress((pct) => downloading(pct));

  updater.onReady((info) => {
    version = info.version;
    if (info.critical) { showCritical(info.version); return; }
    say('ready', 'Update ready', `Version ${version} is ready to install`);
  });

  // A failed download is retried on the next check; a pill stuck at 37% would
  // say otherwise. A ready update stays — the file is already on disk.
  updater.onError((err) => {
    console.error('Update error:', err);
    if (chip.dataset.state !== 'ready') brief('error', 'Update failed', String(err));
  });

  chip.addEventListener('click', () => {
    if (chip.dataset.state === 'ready') return offerInstall();
    checkForUpdates();
  });
}

// Help ▸ Check for updates and the button both land here. A download already
// under way, or a check already out, is left alone rather than started twice.
export async function checkForUpdates() {
  if (!updater || !chip) return;
  const s = chip.dataset.state;
  if (s === 'ready') return offerInstall();
  if (s === 'downloading' || s === 'checking') return;
  say('checking', 'Checking…');
  try {
    const found = await updater.check();
    // Found: onAvailable has already taken the button over for the download.
    if (!found && chip.dataset.state === 'checking') brief('latest', 'Up to date', 'You have the newest version');
  } catch (err) {
    // IPC wraps the main process's message as "Error invoking remote method
    // 'updater:check': Error: <message>" — only the last part is ours.
    const msg = String(err?.message || err).replace(/^.*Error: /, '');
    brief('error', "Can't check", msg);
  }
}

function offerInstall() {
  show(`<div class="upd-pop">
    <b>Version ${version} is ready</b>
    <p>Your scores are autosaved. The app restarts in a few seconds.</p>
    <div class="row"><button class="mbtn" data-upd="later">Later</button><button class="mbtn accent" data-upd="now">Restart now</button></div>
    <small>Later: installs next time you close the app</small>
  </div>`, chip, 'right');
  pop().querySelector('[data-upd="later"]').onclick = hide;
  pop().querySelector('[data-upd="now"]').onclick = () => updater.install();
}

function showCritical(version) {
  if (document.getElementById('updater-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'updater-overlay';
  overlay.className = 'lgd-scrim';
  overlay.innerHTML = `<div class="lgd" role="alertdialog" aria-modal="true" style="max-width:380px;display:block;text-align:center;padding:24px">
    <h2 style="margin:0 0 8px;font-size:17px">Required update</h2>
    <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:var(--ink-2)">Version ${version} fixes a serious problem. Restart to keep working.</p>
    <button class="mbtn accent" id="btnCriticalUpdate" style="width:100%;justify-content:center;background:#d8513a;border-color:#d8513a">Restart and update</button>
  </div>`;
  // Modal: swallow keys so typing over it does not write notes on the staff.
  // Captured on the way DOWN, like about.js, so it lands before note entry.
  document.addEventListener('keydown', (e) => e.stopPropagation(), true);
  document.body.appendChild(overlay);
  document.getElementById('btnCriticalUpdate').addEventListener('click', () => updater.install());
}
