// The menubar's update chip. electron-updater (src/updater.js) downloads in
// the background on its own; this only says so. Hidden until an update is
// found, a quiet progress pill while it downloads, an accent "Update ready"
// once it has landed — click it for Restart now / Later. Later costs nothing:
// autoInstallOnAppQuit installs it the next time the app is closed.
//
// A release whose notes carry [critical] or [security] still gets the
// blocking card instead: that is the one case where "later" is not allowed.

import { show, hide, pop } from './popover.js';

export function initUpdater() {
  const updater = window.hamsleka?.updater;
  const chip = document.getElementById('updChip');
  if (!updater || !chip) return;
  const text = chip.querySelector('.upd-text');
  const bar = chip.querySelector('.upd-bar i');
  let version = '';

  const downloading = (pct) => {
    if (chip.dataset.state === 'ready') return;
    chip.hidden = false;
    chip.dataset.state = 'downloading';
    text.textContent = `Update ${Math.round(pct)}%`;
    bar.style.width = `${pct}%`;
    chip.title = `Downloading version ${version}`;
  };

  updater.onAvailable((info) => { version = info.version; downloading(0); });
  updater.onProgress((pct) => downloading(pct));

  updater.onReady((info) => {
    version = info.version;
    if (info.critical) { showCritical(updater, info.version); return; }
    chip.hidden = false;
    chip.dataset.state = 'ready';
    text.textContent = 'Update ready';
    chip.title = `Version ${version} is ready to install`;
  });

  // A failed download is retried on the next check; a pill stuck at 37% would
  // say otherwise. A ready update stays — the file is already on disk.
  updater.onError((err) => {
    console.error('Update error:', err);
    if (chip.dataset.state !== 'ready') chip.hidden = true;
  });

  chip.addEventListener('click', () => {
    if (chip.dataset.state !== 'ready') return;
    show(`<div class="upd-pop">
      <b>Version ${version} is ready</b>
      <p>Your scores are autosaved. The app restarts in a few seconds.</p>
      <div class="row"><button class="mbtn" data-upd="later">Later</button><button class="mbtn accent" data-upd="now">Restart now</button></div>
      <small>Later: installs next time you close the app</small>
    </div>`, chip, 'right');
    pop().querySelector('[data-upd="later"]').onclick = hide;
    pop().querySelector('[data-upd="now"]').onclick = () => updater.install();
  });
}

function showCritical(updater, version) {
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
