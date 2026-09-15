// Help ▸ About IYDANI.
//
// The only place in the app that states the product in full. Every string in
// it comes from the identity block in config.js — nothing about the name, the
// descriptor or the tagline is typed here — so the About box cannot drift
// away from the titlebar or the menubar lockup.
//
// It reuses the legend's scrim/card markup (.lgd-scrim / .lgd) rather than
// growing a second modal idiom, and the same Esc/scrim/keyboard-swallow rules
// apply: the dialog is modal, so typing over it must not go on writing notes
// onto the staff behind it.

import {
  APP_NAME, APP_DESCRIPTOR, APP_TAGLINE, APP_VENDOR, BRAND_LOCKUP,
} from './config.js';

// Electron's versions come through the preload bridge; in a plain browser
// there is no bridge, so the row is simply left out rather than printed empty.
function versionLines() {
  const b = window.hamsleka;
  if (!b?.versions) return '';
  const v = b.versions;
  const parts = [
    v.electron && `Electron ${v.electron}`,
    v.chrome && `Chromium ${v.chrome}`,
    v.node && `Node ${v.node}`,
  ].filter(Boolean);
  const ver = v.app ? `<div class="abt-ver">Version ${v.app}</div>` : '';
  if (!parts.length) return ver;
  return `${ver}<div class="abt-vers">${parts.join(' · ')}</div>`;
}

function bodyHtml() {
  return `
    <div class="abt-art"><img src="${BRAND_LOCKUP}" alt="${APP_NAME} ${APP_DESCRIPTOR}"></div>
    <div class="abt-tag">${APP_TAGLINE}</div>
    <div class="abt-desc">
      An offline desktop editor for DNG notation — write a score on the staff,
      read it back at true printed size, and play it.
    </div>
    ${versionLines()}
    <div class="abt-legal">© ${APP_VENDOR}. All rights reserved.</div>`;
}

let built = false;

export function openAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;
  if (!built) {
    document.getElementById('aboutBody').innerHTML = bodyHtml();
    built = true;
  }
  overlay.hidden = false;
}

export function closeAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (overlay) overlay.hidden = true;
}

export function wireAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;
  document.getElementById('aboutClose').addEventListener('click', closeAbout);
  // Clicking the scrim closes; clicking the card itself does not.
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeAbout(); });
  // Captured on the way DOWN so it lands before the note-entry listener.
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') closeAbout();
    e.stopPropagation();
  }, true);

  // The menubar lockup is a shortcut to the same dialog — clicking the logo
  // asking "what is this" is the thing About answers.
  const lock = document.getElementById('appBrand');
  if (lock) lock.addEventListener('click', openAbout);
}
