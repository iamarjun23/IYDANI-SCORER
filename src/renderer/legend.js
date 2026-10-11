// "What is what" — the notation legend.
//
// Every glyph in here is drawn by the SAME code that draws the staff:
// noteGlyph() for the sound symbols and noteheads, restMark() for the rests,
// ledgerLines()/noteY() for the sthayi diagram, and repeatGlyphSVG() for the
// braces. Nothing is re-drawn by hand, so the legend cannot end up
// explaining a symbol the editor no longer writes.
//
// The tiles have a white ground because the notation ink is near-black and the
// panel is not: the legend shows the marks as they land on paper.

import {
  SOUND, REST_MAP, DOT_MULT,
  GOLI_R, NOTE_SCALE, STEM_LEN, STEP, TOPY, GTOP, MAGY, BOTY, STAFF,
  TONE_LETTER, semiOf, REST_MID, REST_SPIKE_H,
} from './config.js';
import { state } from './state.js';
import {
  noteGlyph, noteY, ledgerLines, stemTip, stemPointsDown, restMark,
  repeatGlyphSVG, render,
} from './notation.js';

// REST_MAP is rest-key -> sound-name; the legend walks the sounds, so invert it.
const REST_KEY = Object.fromEntries(
  Object.entries(REST_MAP).map(([key, sound]) => [sound, key]),
);

// Beats, written the way a musician says them rather than as decimals.
const BEATS = {
  4: '4 beats', 2: '2 beats', 1: '1 beat',
  0.5: '½ beat', 0.25: '¼ beat', 0.125: '⅛ beat',
  6: '6 beats', 3: '3 beats', 1.5: '1½ beats',
};
const beats = d => BEATS[d] || `${d} beats`;

// The six sound symbols, longest first — the order they are learnt in.
const SOUNDS = [
  ['Maguru', 'Maguru', 'A ring capping the stem.'],
  ['guru', 'Guru', 'A curl capping the stem, bulging right.'],
  ['bindu', 'Bindu', 'The plain note — stem, no ornament.'],
  ['vasu', 'Vasu', 'One bar across the stem.'],
  ['praya', 'Praya', 'Two bars.'],
  ['danta', 'Danta', 'Three bars.'],
];

// One glyph on its own tile. The stem runs UP from the goli, the madhya way, so
// every symbol is shown at the same size and the ornaments line up down the
// column. The box is measured off the glyph's real reach rather than guessed:
// the tip is STEM_LEN past the goli's edge, and the widest ornament is a bar.
const GOLI = GOLI_R * NOTE_SCALE;
const G_TOP = GOLI + STEM_LEN + 6;
const G_BOT = GOLI + 6;
const G_HALF = 15;

function glyphTile(sound, opts = {}) {
  const { filled = false, dot = false, triangle = false } = opts;
  const w = G_HALF * 2 + (dot ? 10 : 0);
  const body = noteGlyph(0, 0, sound, filled, 1, dot, null, triangle);
  return `<svg class="lgd-glyph" viewBox="${-G_HALF} ${-G_TOP} ${w} ${G_TOP + G_BOT}"`
    + ` width="${w * 1.15}" height="${(G_TOP + G_BOT) * 1.15}">${body}</svg>`;
}

// The rests, drawn by the staff's own restMark(). R_HALF clears the widest of
// them — Maguru's ring — and the box is the wedge's own height with a little
// air, so all six tiles line up on REST_MID the way they do on the staff.
const R_HALF = 13;
const R_PAD = 4;

function restTile(sound) {
  const key = REST_KEY[sound];
  if (!key) return '';
  const top = REST_MID - REST_SPIKE_H / 2 - R_PAD;
  const h = REST_SPIKE_H + R_PAD * 2;
  return `<svg class="lgd-glyph" viewBox="${-R_HALF} ${top} ${R_HALF * 2} ${h}"`
    + ` width="${R_HALF * 2 * 1.15}" height="${h * 1.15}">${restMark(0, key)}</svg>`;
}

function row(art, name, note) {
  return `<div class="lgd-row"><div class="lgd-art">${art}</div>`
    + `<div><b>${name}</b><span>${note}</span></div></div>`;
}

// The pitch chart: all three sthayis written out across one staff, every goli
// named. This is the figure from Files/OCTAVES NOTES PLACMENT.svg, drawn by the
// editor's own functions — noteY places the golis, ledgerLines draws the
// ledgers, stemPointsDown/stemTip aim the stems — so it is a picture of what
// this build actually writes, not an illustration of what it ought to.
// The seven naturals, named the way the Legend toggle names them on the staff —
// the piano key's letter, TONE_LETTER through semiOf() — so the chart and the
// sheet cannot letter the same goli differently. See svaraName() in notation.js.
const nameOf = svi => TONE_LETTER[semiOf(svi, 'o') % 12];

// One entry per goli: mandra S..N, madhya S..N, taara S..N, then the Sá that
// closes the top octave — 22 in all, the same run the drawing shows.
const CHART = [
  ...[-1, 0, 1].flatMap(oct => [0, 1, 2, 3, 4, 5, 6].map(svi => ({ svi, oct, name: nameOf(svi) }))),
  { svi: 7, oct: 1, name: nameOf(0) },
];

const CH_LEAD = 74;      // clef and opening barline
const CH_STEP = 32;      // horizontal room per goli
const CH_GAP = 10;       // extra breath at a sthayi boundary
const CH_PAD = 22;       // staff carried on past the last note

function staffFigure() {
  // The empty rungs of the outer octaves — the magic line's counterparts, which
  // the drawing marks with a long dotted rule. They are DERIVED from the ladder
  // (the rung Ga steps over) rather than typed in, so they cannot fall out of
  // step with it.
  const voids = [-1, 1].map(oct => noteY(3, oct) + STEP / 2);

  const xs = [];
  let x = CH_LEAD;
  CHART.forEach((n, i) => {
    if (i && n.oct !== CHART[i - 1].oct) x += CH_GAP;
    xs.push(x);
    x += CH_STEP;
  });
  const W = x + CH_PAD;

  const top = noteY(7, 1) - 26;
  const bot = noteY(0, -1) + 28;

  let s = `<svg class="lgd-staff" viewBox="0 ${top} ${W} ${bot - top}"`
        + ` width="${W}" height="${bot - top}" preserveAspectRatio="xMidYMid meet">`;
  s += `<rect x="0" y="${GTOP}" width="${W}" height="${BOTY - GTOP}" fill="${STAFF.greenFill}"/>`;
  for (const y of [TOPY, GTOP, MAGY, BOTY]) {
    s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"/>`;
  }
  for (const y of voids) {
    s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#8d867c" stroke-width="0.7" stroke-dasharray="1.4 5"/>`;
  }
  // Clef and opening barline, as every printed row carries them.
  s += `<circle cx="26" cy="${MAGY}" r="5" fill="#fff" stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"/>`;
  s += `<line x1="20" y1="${MAGY}" x2="32" y2="${MAGY}" stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"/>`;
  s += `<line x1="52" y1="${TOPY}" x2="52" y2="${BOTY}" stroke="${STAFF.stroke}" stroke-width="1.4"/>`;

  CHART.forEach((n, i) => {
    const gx = xs[i];
    const y = noteY(n.svi, n.oct);
    const down = stemPointsDown(n.svi, n.oct);
    s += ledgerLines(gx, n.svi, n.oct);
    s += noteGlyph(gx, y, 'bindu', false, down ? -1 : 1, false, stemTip(n.svi, n.oct));
    // The name goes on the side of the goli the stem does NOT leave from, so it
    // never collides with the stem or the ornament riding its tip.
    const ly = down ? y - 9 : y + 15;
    s += `<text x="${gx}" y="${ly}" class="lgd-name">${n.name}</text>`;
  });
  return s + '</svg>';
}

function bodyHtml() {
  const sounds = SOUNDS
    .map(([sym, name, note]) => row(glyphTile(sym), `${name} — ${beats(SOUND[sym].dur)}`, note))
    .join('');

  const heads = [
    row(glyphTile('bindu'), 'Hollow goli — natural', 'The seven svaras of the scale: S R G m P D N.'),
    row(glyphTile('bindu', { filled: true }), 'Filled goli — lowered', 'The four flat variants: r g d n.'),
    row(glyphTile('bindu', { triangle: true }), 'Triangle — M', 'Prati madhyama, the one variant that is RAISED. A filled goli would read as lowered, so it takes its own head.'),
  ].join('');

  const chukki = row(
    glyphTile('bindu', { dot: true }),
    `Chukki — ${beats(SOUND.bindu.dur * DOT_MULT)}`,
    'A dot beside the goli adds half again — which is exactly the next symbol down, so a dotted guru reads as "guru and bindu".',
  );

  const rests = SOUNDS
    .filter(([sym]) => REST_KEY[sym])
    .map(([sym, name]) => row(
      restTile(sym),
      `${name} rest — ${beats(SOUND[sym].dur)}`,
      'Silence of the same weight as the sound symbol.',
    )).join('');

  // Both braces of the pair, drawn by the staff's own repeatMark() — so the
  // guide shows the mark this build writes rather than a picture of one.
  const repeats = [2, 3, 4].map(count => row(
    repeatGlyphSVG('pair', count, 44, 38, 'lgd-rep', STAFF.noteInk),
    `Repeat ×${count}`,
    'Everything between the opening and closing mark is played this many times'
    + ` — the dots say how many: ${count}.`,
  )).join('');

  const sthayi = [
    row('<i class="lgd-sth up"></i>', 'Taara — above the staff', 'The upper sthayi. Stems hang down toward the staff.'),
    row('<i class="lgd-sth mid"></i>', 'Madhya — on the staff', 'The middle sthayi, between the top and bottom lines.'),
    row('<i class="lgd-sth dn"></i>', 'Mandra — below the staff', 'The lower sthayi. Stems rise toward the staff.'),
  ].join('');

  return `
    <section><h4>Sound symbols — how long the note lasts</h4>${sounds}</section>
    <section><h4>The chukki</h4>${chukki}</section>
    <section><h4>The notehead — which of the twelve tones</h4>${heads}</section>
    <section><h4>Rests — the same weights, in silence</h4>${rests}</section>
    <section><h4>Repeat marks</h4>${repeats}</section>
    <section class="wide">
      <h4>The staff and the three sthayis</h4>
      <div class="lgd-fig">${staffFigure()}</div>
      <p>Every svara sits half a line-space above the one below it, and the ladder
         simply carries on past the staff on ledger lines — so how far out you are
         is read off the LEDGER COUNT. One rung per octave carries no notation:
         the magic line inside the staff, and the two dotted rules outside it. Ga
         steps over that rung to reach Ma, which is why an octave is four whole
         line-spaces — one staff height — in all three sthayis.</p>
      ${sthayi}
      <p>The ▲ ■ ▼ beside each row's number is that same key, printed on the sheet.</p>
    </section>`;
}

let built = false;

export function openLegend() {
  const overlay = document.getElementById('legendOverlay');
  if (!overlay) return;
  if (!built) {
    document.getElementById('legendBody').innerHTML = bodyHtml();
    built = true;
  }
  overlay.hidden = false;
}

export function closeLegend() {
  const overlay = document.getElementById('legendOverlay');
  if (overlay) overlay.hidden = true;
}

// The toolbar's Legend button writes the svara names onto the sheet — the
// notation, named in place. Rendering reads state.showNames (see svaraName in
// notation.js), so the names follow the score into print, SVG and PDF.
export function toggleNames() {
  state.showNames = !state.showNames;
  const btn = document.getElementById('legendBtn');
  if (btn) btn.classList.toggle('on', state.showNames);
  render();
}

export function wireLegend() {
  const btn = document.getElementById('legendBtn');
  const overlay = document.getElementById('legendOverlay');
  if (btn) btn.addEventListener('click', toggleNames);
  if (!overlay) return;
  document.getElementById('legendClose').addEventListener('click', closeLegend);
  // Clicking the scrim closes; clicking the card itself does not.
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeLegend(); });
  // The legend is modal, so it swallows the keyboard while it is up — otherwise
  // typing over it would go on writing notes onto the staff behind. Captured on
  // the way DOWN so it lands before the note-entry listener.
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') closeLegend();
    e.stopPropagation();
  }, true);
}
