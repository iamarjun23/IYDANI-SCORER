// Language picker. Choosing a language switches the INTERFACE — headings,
// menus and labels, through i18n.js — and the svara script shown on the piano
// and the keyboard map (that half only in DNR mode; DNG always letters in
// English). The choice is a preference, so it is kept in settings.js.

import { state } from './state.js';
import { LANGS } from './config.js';
import { show, hide, pop } from './popover.js';
import { buildPiano } from './piano.js';
import { buildKeyMap } from './keymap.js';
import { setSetting } from './settings.js';
import { l10n, applyLang } from './i18n.js';

// Everything on screen that depends on state.lang, repainted from it. Called
// at startup too, so a saved language is in force before the first frame.
export function refreshLanguage() {
  document.getElementById('langLabel').textContent = LANGS[state.lang];
  applyLang();
  buildPiano();
  buildKeyMap();
  // The metre button and the connection pill write their own text.
  document.dispatchEvent(new Event('lang:changed'));
}

export function openLanguagePicker() {
  const anchor = document.getElementById('langBtn');
  const html =
    `<div class="ttl">${l10n('Language')}</div>` +
    Object.keys(LANGS).map(k =>
      `<div class="it ${state.lang === k ? 'sel' : ''}" data-lang="${k}">${LANGS[k]}</div>`
    ).join('') +
    '<div class="hr"></div>' +
    '<div class="cw-note">Regional script shows on the piano &amp; keys when <b>DNR</b> is selected.</div>';

  show(html, anchor, 'right');
  pop().querySelectorAll('[data-lang]').forEach(el =>
    el.addEventListener('click', () => {
      setSetting('lang', el.dataset.lang);
      refreshLanguage();
      hide();
    }),
  );
}
