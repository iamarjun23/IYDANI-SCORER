// A live check of the section roll, driven through the running app.
//
//   npx electron . --remote-debugging-port=9334
//   node tests/section-ui.smoke.mjs 9334
//
// tests/section.test.mjs drives the MODEL — where a lane is, what a nudge does
// to state.notes. It cannot drive a drag, because a drag is pointer events on
// elements that only exist in a renderer. This does the other half: it opens a
// division, checks the roll drew the ladder it claims to, and then re-pitches a
// note by pressing, moving and releasing a real (trusted) pointer, which is the
// only way to find out whether the gesture is wired to the mutation.

const port = process.argv[2] || '9334';
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

const mouse = (type, x, y, extra = {}) => command('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
  clickCount: 1, ...extra,
});

const wait = ms => new Promise(r => { setTimeout(r, ms); });

let checks = 0;
const is = (a, b, m) => {
  checks += 1;
  if (a !== b) throw new Error(`${m}\n  expected ${b}\n  actual   ${a}`);
};
const ok = (v, m) => { checks += 1; if (!v) throw new Error(m); };

// ---- a score to look at ---------------------------------------------------
// Written straight into state so the check does not depend on what the app
// happened to have open. Sa Ri Ga Ma in madhya: four bindus, one division.

await evaluate(`(async () => {
  const { state } = await import('./state.js');
  const { render } = await import('./notation.js');
  state.notes = [0, 1, 2, 3].map(svaraIndex => ({
    type: 'note', svaraIndex, oct: 0, head: '', sym: 'bindu', dur: 1,
  }));
  state.bars = []; state.breaks = []; state.hist = []; state.future = [];
  render();
})()`);
await wait(150);

// Open the first division the way a click does.
await evaluate(`document.querySelector('#score .section-hit')
  .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await wait(150);

// ---- what the roll drew ---------------------------------------------------

const drawn = await evaluate(`(() => {
  const roll = document.querySelector('#inspectBody .roll');
  if (!roll) return null;
  const keys = [...roll.querySelectorAll('.roll-key')];
  return {
    lanes: roll.querySelectorAll('.roll-lane').length,
    dead: roll.querySelectorAll('.roll-lane.dead').length,
    keys: keys.length,
    letters: keys.map(k => k.textContent.trim()[0] || '-').join(''),
    blocks: roll.querySelectorAll('.roll-blk').length,
    editable: roll.querySelectorAll('.roll-blk.edit').length,
    rests: roll.querySelectorAll('.roll-rest').length,
    beats: roll.querySelectorAll('.roll-tick').length,
    rows: document.querySelectorAll('#inspectBody .stime-row').length,
    trackH: roll.querySelector('.roll-track').getBoundingClientRect().height,
    keysH: roll.querySelector('.roll-keys').getBoundingClientRect().height,
    tops: [...roll.querySelectorAll('.roll-blk')].map(b => Math.round(b.getBoundingClientRect().top)),
  };
})()`);

ok(drawn, 'the section panel opened as a roll');
is(drawn.lanes, 24, 'the ladder is 24 lanes');
is(drawn.dead, 3, 'three of them are dead');
is(drawn.keys, 24, 'the gutter names every lane');
is(drawn.letters, 'NDPM-GRSNDPM-GRSNDPM-GRS', 'and reads as the ladder three times over');
is(drawn.blocks, 4, 'four notes, four blocks');
is(drawn.editable, 4, 'every one of them can be dragged');
is(drawn.beats, 4, 'the metre is ruled across it');
is(drawn.rows, 4, 'the list under it still names them');
is(Math.round(drawn.trackH), Math.round(drawn.keysH), 'the keys line up with the lanes');
// Sa Ri Ga Ma climbs, so each block sits ABOVE the one before it. This is the
// whole point of the roll: the shape of the phrase is visible.
ok(drawn.tops.every((t, i) => i === 0 || t < drawn.tops[i - 1]),
  'a rising phrase rises on the roll');

// ---- a drag that re-pitches ----------------------------------------------
// Two lanes UP from Sa is Ga (Sa -> Ri -> Ga: consecutive rungs, none dead).

const box = await evaluate(`(() => {
  const b = document.querySelector('#inspectBody .roll-blk');
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
})()`);

const before = await evaluate(`document.querySelector('#score .glyph[data-kind="note"]').dataset.svi`);
is(Number(before), 0, 'the first note is Sa to begin with');

await mouse('mousePressed', box.x, box.y);
await mouse('mouseMoved', box.x, box.y - box.h * 2 - 2);
await wait(30);
await mouse('mouseReleased', box.x, box.y - box.h * 2 - 2);
await wait(200);

const after = await evaluate(`document.querySelector('#score .glyph[data-kind="note"]').dataset.svi`);
is(Number(after), 2, 'dragging it up two lanes wrote Ga on the staff');

const undone = await evaluate(`(async () => {
  const { undo } = await import('./history.js');
  undo();
  return document.querySelector('#score .glyph[data-kind="note"]').dataset.svi;
})()`);
is(Number(undone), 0, 'and ONE undo puts it back — the drag was one edit');

// ---- the panel survived it -------------------------------------------------

const still = await evaluate(`document.querySelectorAll('#inspectBody .roll-blk').length`);
is(still, 4, 'the roll put itself back after the re-render');

// ---- shift-click flips the notehead ---------------------------------------
// Ri is one of the two svaras the base scale takes the LOWERED form of, so the
// second block starts filled and the flip has somewhere to go.

const ri = await evaluate(`(() => {
  const b = document.querySelectorAll('#inspectBody .roll-blk')[1];
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, filled: b.classList.contains('var') };
})()`);
ok(ri.filled, 'Ri is drawn as the lowered form to begin with');

await mouse('mousePressed', ri.x, ri.y, { modifiers: 8 });      // 8 = shift
await mouse('mouseReleased', ri.x, ri.y, { modifiers: 8 });
await wait(200);
is(await evaluate(`document.querySelectorAll('#score .glyph[data-kind="note"]')[1].dataset.head`),
  'o', 'shift-click wrote the natural instead');
is(await evaluate(`document.querySelectorAll('#inspectBody .roll-blk')[1].classList.contains('var')`),
  false, '...and the block stopped marking itself as a variant');

// ---- a sideways drag edits the gap ----------------------------------------

const rests0 = await evaluate(`document.querySelectorAll('#inspectBody .roll-rest').length`);
is(rests0, 0, 'a full division has no silence in it');

const third = await evaluate(`(() => {
  const b = document.querySelectorAll('#inspectBody .roll-blk')[2];
  const r = b.getBoundingClientRect();
  const t = document.querySelector('#inspectBody .roll-track').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, beat: t.width / 4 };
})()`);

await mouse('mousePressed', third.x, third.y);
await mouse('mouseMoved', third.x + third.beat, third.y);
await wait(30);
await mouse('mouseReleased', third.x + third.beat, third.y);
await wait(220);

const gap = await evaluate(`(async () => {
  const { state } = await import('./state.js');
  const rests = state.notes.filter(n => n.type === 'rest');
  return {
    rests: rests.length,
    units: rests.reduce((u, n) => u + Math.round(n.dur * 8), 0),
    notes: state.notes.filter(n => n.type === 'note').length,
  };
})()`);
is(gap.notes, 4, 'nothing was swallowed to make room');
is(gap.units, 8, 'a beat of silence was written in front of it');
ok(gap.rests >= 1, '...as real rests, not as an offset');

// ---- and stops at the note in front of it ---------------------------------
// The second block now has a note immediately before it and no gap to absorb,
// so dragging it left has nothing to take and must change nothing at all.

await evaluate(`document.querySelector('#score .section-hit')
  .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await wait(150);
const wall = await evaluate(`(() => {
  const b = document.querySelectorAll('#inspectBody .roll-blk')[1];
  const r = b.getBoundingClientRect();
  const t = document.querySelector('#inspectBody .roll-track').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, beat: t.width / 4 };
})()`);
const beforeWall = await evaluate(`(async () => JSON.stringify(
  (await import('./state.js')).state.notes.map(n => n.type + (n.svaraIndex ?? ''))))()`);
await mouse('mousePressed', wall.x, wall.y);
await mouse('mouseMoved', wall.x - wall.beat, wall.y);
await wait(30);
await mouse('mouseReleased', wall.x - wall.beat, wall.y);
await wait(220);
is(await evaluate(`(async () => JSON.stringify(
  (await import('./state.js')).state.notes.map(n => n.type + (n.svaraIndex ?? ''))))()`),
  beforeWall, 'dragging into the note in front of it changes nothing');

socket.close();
console.log(`section-ui: ${checks} checks passed`);
