// npm run test:pdf
//
// exportPDF() draws the sheet's furniture with jsPDF primitives, and jsPDF
// reports a bad argument from deep inside its own call stack — a NaN colour
// channel surfaces as "Invalid argument passed to jsPDF.f2" thrown three frames
// away from the constant that caused it. So this drives the real export against
// a recording stub and asserts that EVERY number it hands jsPDF is finite and
// lands on the page.
//
// It is a stub, not a renderer: nothing here checks what the PDF looks like.
// What it checks is that the export runs end to end and never passes jsPDF a
// number it cannot use.

import assert from 'node:assert/strict';

const calls = [];
const PAGE_W = 210, PAGE_H = 297;

// Methods whose numeric arguments are page coordinates or sizes. `text` is
// excluded from the bounds check on its first argument, which is a string.
const DRAW = new Set(['rect', 'roundedRect', 'circle', 'triangle', 'line', 'text']);

class FakeDoc {
  constructor() {
    this.pages = 1;
    this.internal = { getNumberOfPages: () => this.pages };
  }

  record(name, args) {
    calls.push({ name, args });
    args.forEach((a, i) => {
      if (typeof a !== 'number') return;
      assert.ok(Number.isFinite(a), `${name} arg ${i} is ${a}`);
      if (DRAW.has(name)) {
        // Generous bounds: catches a coordinate computed off a NaN or a wildly
        // wrong unit, not a mark that sits a hair off the paper.
        assert.ok(a > -50 && a < Math.max(PAGE_W, PAGE_H) + 50,
          `${name} arg ${i} = ${a} is off the page`);
      }
    });
    return this;
  }
}

for (const m of ['setFont', 'setFontSize', 'setTextColor', 'setDrawColor', 'setFillColor',
  'setLineWidth', 'rect', 'roundedRect', 'circle', 'triangle', 'line', 'text', 'save']) {
  FakeDoc.prototype[m] = function (...args) { return this.record(m, args); };
}
FakeDoc.prototype.getTextWidth = function (s) { return String(s).length * 2; };
FakeDoc.prototype.addPage = function () { this.pages++; return this.record('addPage', []); };
FakeDoc.prototype.setPage = function (p) { return this.record('setPage', [p]); };

// A colour channel jsPDF would reject. setDrawColor/setFillColor/setTextColor
// are the three that take them, and all three are spread from rgb().
for (const m of ['setTextColor', 'setDrawColor', 'setFillColor']) {
  const inner = FakeDoc.prototype[m];
  FakeDoc.prototype[m] = function (...args) {
    for (const [i, a] of args.entries()) {
      assert.ok(typeof a === 'number' && Number.isFinite(a) && a >= 0 && a <= 255,
        `${m} channel ${i} is ${a} — jsPDF throws "Invalid argument passed to jsPDF.f2" on this`);
    }
    return inner.apply(this, args);
  };
}

const el = () => ({
  style: {},
  setAttribute() {},
  appendChild() {},
  remove() {},
  querySelectorAll: () => [],
});

globalThis.window = {
  jspdf: { jsPDF: FakeDoc },
  svg2pdf: async () => {},
};
globalThis.document = {
  baseURI: 'file:///app/renderer/',
  body: { appendChild() {} },
  createElement: el,
  // No live sheet in Node, so the emblem is skipped — the rest of the head is
  // what this exercises.
  querySelector: () => null,
};
globalThis.DOMParser = class {
  parseFromString() { return { documentElement: el() }; }
};
globalThis.Image = class {
  set src(v) { this._src = v; if (this.onload) this.onload(); }
  get src() { return this._src; }
};

const { exportPDF } = await import('../src/renderer/pdf.js');
const { state } = await import('../src/renderer/state.js');
const { SOUND } = await import('../src/renderer/config.js');

// An empty score first — the page furniture on its own.
await exportPDF();
assert.ok(calls.length > 0, 'the export drew something');
assert.ok(calls.some(c => c.name === 'save'), 'and finished by saving');

// Then a score long enough to run past the foot of page one, so the page break,
// the continuation page and the per-page footer all get drawn.
const note = (svaraIndex, oct, sym) => ({
  type: 'note', svaraIndex, oct, head: 'auto', sym,
  dur: SOUND[sym].dur, deco: SOUND[sym].deco,
});
state.notes = [];
for (let i = 0; i < 400; i++) {
  state.notes.push(note(i % 7, [-1, 0, 1][i % 3], ['danta', 'praya', 'bindu', 'Maguru'][i % 4]));
}
calls.length = 0;
await exportPDF();
assert.ok(calls.some(c => c.name === 'addPage'), 'a long score breaks onto a second page');
const footers = calls.filter(c => c.name === 'roundedRect');
assert.ok(footers.length >= 2, 'and every page gets its own pill');

console.log(`pdf export tests passed (${calls.length} jsPDF calls checked)`);
