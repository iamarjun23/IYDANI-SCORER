// Cowork (live collaboration) popover. UI-only mock for now — the live
// session backend (Yjs + Hocuspocus + WebRTC) is described in docs/ but
// not yet implemented.

import { state } from './state.js';
import { show, hide, pop } from './popover.js';

const ROOM_LINK = 'dng.studio/s/AB12-CD34';

export function openCowork() {
  const anchor = document.getElementById('coworkBtn');
  const role = state.cwRole;

  const html = `
    <div class="ttl">Cowork Session</div>
    <div class="cw-link"><span class="mono">${ROOM_LINK}</span><button class="cw-copy" id="cwCopy">Copy</button></div>
    <div class="cw-role">Your role
      <div class="seg" id="cwRole">
        <button data-r="teacher" class="${role === 'teacher' ? 'active' : ''}">Teacher</button>
        <button data-r="student" class="${role === 'student' ? 'active' : ''}">Student</button>
      </div>
    </div>
    <div class="hr"></div>
    <div class="ttl">In the room</div>
    <div class="cw-list">
      <div class="cw-p"><span class="av" style="background:#3f63bf">G</span><div class="who"><b>You</b><small id="cwYouRole">${role === 'teacher' ? 'Teacher · editing' : 'Student · editing'}</small></div><span class="pres on"></span></div>
      <div class="cw-p"><span class="av" style="background:#3f9a5c">A</span><div class="who"><b>Ananya</b><small>Student · viewing</small></div><span class="pres on"></span></div>
      <div class="cw-p"><span class="av" style="background:#dd8a2a">R</span><div class="who"><b>Ravi</b><small>Student · viewing</small></div><span class="pres"></span></div>
    </div>
    <div class="cw-note">Edits sync live with everyone in the room.</div>
  `;

  show(html, anchor, 'right');

  document.getElementById('cwCopy').onclick = function () {
    try { navigator.clipboard.writeText(ROOM_LINK); } catch (e) {}
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = 'Copy'; }, 1200);
  };

  document.getElementById('cwRole').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.cwRole = b.dataset.r;
    document.querySelectorAll('#cwRole button').forEach(x => x.classList.toggle('active', x === b));
    document.getElementById('cwYouRole').textContent =
      (b.dataset.r === 'teacher' ? 'Teacher' : 'Student') + ' · editing';
  });
}
