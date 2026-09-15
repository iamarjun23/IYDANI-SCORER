// Language picker. Choosing a language swaps the svara script shown on the
// piano and the keyboard map (only when DNR mode is active — DNG mode always
// uses English labels).

import { state } from './state.js';
import { LANGS } from './config.js';
import { show, hide, pop } from './popover.js';
import { buildPiano } from './piano.js';
import { buildKeyMap } from './keymap.js';

export function openLanguagePicker() {
  const anchor = document.getElementById('langBtn');
  const html =
    '<div class="ttl">Language</div>' +
    Object.keys(LANGS).map(k =>
      `<div class="it ${state.lang === k ? 'sel' : ''}" data-lang="${k}">${LANGS[k]}</div>`
    ).join('') +
    '<div class="hr"></div>' +
    '<div class="cw-note">Regional script shows on the piano &amp; keys when <b>DNR</b> is selected.</div>';

  show(html, anchor, 'right');
  pop().querySelectorAll('[data-lang]').forEach(el =>
    el.addEventListener('click', () => {
      state.lang = el.dataset.lang;
      document.getElementById('langLabel').textContent = LANGS[state.lang];
      buildPiano();
      buildKeyMap();
      hide();
    }),
  );
}
