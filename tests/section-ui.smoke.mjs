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

// ---- the control row and the keys ------------------------------------------
// A click SELECTS. The row under the roll carries only what a drag cannot say
// (length as a symbol, chukki, notehead, delete); pitch and position are the
// arrow keys while the roll has the focus. Driven on a fresh score so nothing
// above decides what is selected.

await evaluate(`(async () => {
  const { state } = await import('./state.js');
  const { render } = await import('./notation.js');
  state.notes = [0, 2, 4].map(svaraIndex => ({
    type: 'note', svaraIndex, oct: 0, head: '', sym: 'bindu', dur: 1,
  }));
  state.bars = []; state.breaks = []; state.hist = []; state.future = [];
  render();
})()`);
await wait(150);
await evaluate(`document.querySelector('#score .section-hit')
  .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await wait(150);

ok(await evaluate(`document.querySelector('#inspectBody .sed').classList.contains('empty')`),
  'with nothing selected the control row is the how-to');

const ga = await evaluate(`(() => {
  const r = document.querySelectorAll('#inspectBody .roll-blk')[1].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await mouse('mousePressed', ga.x, ga.y);
await mouse('mouseReleased', ga.x, ga.y);
await wait(150);
is(await evaluate(`document.querySelectorAll('#inspectBody .roll-blk.sel').length`), 1,
  'a click selects the note');
is(await evaluate(`document.querySelector('#inspectBody .sec-lcd b')?.textContent.trim()`), '○ Ga',
  '...and the readout names it');
is(await evaluate(`document.querySelectorAll('#inspectBody .roll-key.sel').length`), 1,
  '...and its lane is lit in the key column');
is(await evaluate(`document.activeElement?.dataset.act`), 'roll',
  '...and the roll has the focus, so the arrow keys are its');

const VK = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Delete: 46 };
const key = async (k, modifiers = 0) => {
  const ev = { key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers };
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  await wait(200);
};
const press = async act => {
  const b = await evaluate(`(() => {
    const el = document.querySelector('#inspectBody .sed [data-act="${act}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await mouse('mousePressed', b.x, b.y);
  await mouse('mouseReleased', b.x, b.y);
  await wait(200);
};
const second = () => evaluate(`(async () => {
  const { state } = await import('./state.js');
  const i = state.notes.findIndex(n => n.type === 'note' && n.svaraIndex !== 0);
  return { ...state.notes[i], before: state.notes.slice(0, i).reduce((u, n) => u + n.dur, 0) };
})()`);
const sequence = () => evaluate(`(async () => (await import('./state.js')).state.notes
  .map(n => n.type + (n.svaraIndex ?? '') + ':' + n.dur).join(' '))()`);

await key('ArrowUp', 8);                                        // 8 = shift
is((await second()).oct, 1, 'shift-up wrote taara');
await key('ArrowUp');
is((await second()).svaraIndex, 3, 'up stepped OVER the dead lane, Ga to Ma');
const walled = await sequence();
await key('ArrowLeft');
is(await sequence(), walled, 'there is no silence in front of it, so left changes nothing');
await key('ArrowRight');
is((await second()).before, 1.125, 'right put a danta of silence in front of it');
is(await evaluate(`document.querySelectorAll('#inspectBody .roll-blk.sel').length`), 1,
  'and it is still the selected note, though its index moved');
is(await evaluate(`document.activeElement?.dataset.act`), 'roll',
  '...with the focus still on the roll');

await press('var');
is((await second()).head, 'f', 'the notehead button wrote the raised Ma');
await evaluate(`(() => {
  const el = document.querySelector('#inspectBody .sed-len');
  el.value = '2';
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await wait(200);
is((await second()).dur, 2, 'the length menu made it a Guru');
await press('dot');
is((await second()).dur, 3, '...and the chukki half as long again');

// Delete leaves the silence the note was taking up, so nothing after it moves.
const total = () => evaluate(`(async () => (await import('./state.js')).state.notes
  .reduce((u, n) => u + n.dur, 0))()`);
const lengthBefore = await total();
await press('del');
is(await evaluate(`(async () => (await import('./state.js')).state.notes
  .filter(n => n.type === 'note').length)()`), 2, 'Delete took the note out');
is(await total(), lengthBefore, '...and left its length behind as silence');

// ---- stepping between divisions -------------------------------------------
is(await evaluate(`document.querySelector('#inspectBody [data-act="prev"]').disabled`), true,
  'the first box has nothing before it');
await evaluate(`document.querySelector('#inspectBody [data-act="next"]').click()`);
await wait(150);
is(await evaluate(`document.querySelector('#inspectBody .ihead .big').textContent`), 'Box 2',
  'the next button opened the next box');
is(await evaluate(`document.querySelectorAll('#score .section-hit.sel').length`), 1,
  '...and the staff marks that one');

socket.close();
console.log(`section-ui: ${checks} checks passed`);
