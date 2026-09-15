// Save / export. .dng.json is the project format; .svg is a flat export.

import { state } from './state.js';
import { talaForSave } from './timesig.js';
import { binds } from './keybinds.js';
import { rowSVG, scoreRows, expandScore, rowExtent } from './notation.js';
import { VW, toCM } from './config.js';

function download(name, type, data) {
  const blob = new Blob([data], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeName(s) {
  return (s || 'untitled').replace(/\s+/g, '_');
}

export function downloadJSON() {
  // Save the expanded score so the rests padding a partly-filled box are in
  // the file. Repeat marks come back remapped onto the expanded indices, so
  // reopening lands them on the same notes.
  const score = expandScore();
  download(
    safeName(state.title) + '.dng.json',
    'application/json',
    JSON.stringify({
      title: state.title,
      tala:  state.tala,
      // The metre travels with the score, definition and all, so a file
      // written in a custom time signature opens correctly on a machine that
      // has never seen it. The key alone would land on the fallback.
      timeSig: talaForSave(),
      scale: 'Mayamalavagowla',
      bpm:   state.bpm,
      saMidi: state.saMidi,
      notes: score.notes,
      bars:  score.bars,
      // Layout, not music: the divisions the sheet is broken at.
      breaks: state.breaks,
      // The keyboard layout the score was written on.
      keyBinds: binds(),
    }, null, 2),
  );
}

export function exportSVG() {
  const rows = scoreRows();

  // Rows nest as <svg> children of a unit-space parent, so their cm sizing is
  // replaced by an explicit unit-space viewport at the row's stacking offset.
  // The outer element carries the physical size; the rows inherit it. Row
  // heights vary with content (mandra/taara stems), so each row is stacked by
  // its own measured height rather than a fixed step.
  let inner = '';
  let H = 0;
  rows.forEach(row => {
    const h = rowExtent(row).height;
    inner += rowSVG(row, null, null, false).replace(
      /^<svg /,
      `<svg x="0" y="${H}" width="${VW}" height="${h}" `,
    ).replace(/ (width|height)="[\d.]+cm"/g, '');
    H += h;
  });
  download(
    safeName(state.title) + '.svg',
    'image/svg+xml',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${H}"`
    + ` width="${toCM(VW).toFixed(4)}cm" height="${toCM(H).toFixed(4)}cm">`
    + `<rect width="100%" height="100%" fill="#fff"/>${inner}</svg>`,
  );
}
