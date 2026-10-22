// PDF export via vendored jsPDF + svg2pdf.js (loaded as UMD globals in
// index.html before the module scripts run).
//
// THE RULE HERE: the PDF is the sheet. Everything this file draws — the emblem,
// the head rule, the tone legend, the four meta fields, the row gutter, the
// page pill, the brand line — is the same furniture `.sheet` carries in
// index.html, at the same size and in the same place, because a printed page
// that does not match the page on screen is a bug however good it looks. The
// measurements are NOT retyped here: they come from the printed-page block in
// config.js, which is written once from the stylesheet's own pixel values.
//
// The score rows themselves go through rowSVG() and svg2pdf, so the notation
// cannot differ at all; only the page furniture has to be rebuilt by hand,
// because jsPDF has no DOM to lay it out with.

import { state } from './state.js';
import { rowSVG, scoreRows, rowExtent, pageLayout } from './notation.js';
import {
  VW,
  TOPY, MAGY, BOTY, toMM,
  TONE_LETTER, TONE_MARK,
  PAGE_W_MM, PAGE_H_MM, SHEET_PAD_X, SHEET_PAD_TOP,
  EMBLEM_MM, HEAD_RULE_W, HEAD_H, META_Y,
  TONE_CELL_W, TONE_ROW_H, TONE_MK_H, TONE_BORDER, TONE_PT, TONE_BG, TONE_LINE,
  MK_O_R, MK_O_W, MK_F_R, MK_T_W, MK_T_H,
  META_GAP, META_LINE, META_PT, META_VAL_GAP,
  PILL_BOTTOM, PILL_W_MM, PILL_H_MM, PILL_R_MM, PILL_PT,
  BRAND_RIGHT, BRAND_BOTTOM, BRAND_PT, BRAND_COLOR, SHEET_INK, rgb,
  GUTTER_NUM_X, GUTTER_MARK_X, GUTTER_NUM_SIZE, GUTTER_SQ,
  GUTTER_TRI_W, GUTTER_TRI_H, GUTTER_OUT, GUTTER_MID_OFFSET,
} from './config.js';
import { beatsPerBox } from './timesig.js';

// The sheet's content box. The row SVG is exactly this wide, which is what puts
// the 18 cm staff inside it 15 mm from each paper edge.
const LEFT = SHEET_PAD_X;
const RIGHT = PAGE_W_MM - SHEET_PAD_X;

// mm of cap height for a given point size — enough to sit text on a centre line
// the way a CSS line box does.
const capMM = pt => pt * 0.352 * 0.72;

const GUTTER_INK = [31, 27, 32];

function svgFromString(str) {
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
  return doc.documentElement;
}

// Render one off-DOM SVG element into the page at a given box. svg2pdf reads
// dimensions from the element, so it has to be in the document briefly for
// getBBox to resolve. A row is pure drawn markup — notes, rests and now the
// repeat marks too — so there is nothing left in it to fetch.
async function placeSVG(svg2pdf, doc, el, x, y, w, h) {
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  const hidden = document.createElement('div');
  hidden.style.cssText = 'position:absolute;left:-9999px;top:0;';
  hidden.appendChild(el);
  document.body.appendChild(hidden);
  try {
    await svg2pdf(el, doc, { x, y, width: w, height: h });
  } finally {
    hidden.remove();
  }
}

// ---------- the sheet head ----------

// The emblem is taken from the live sheet rather than redrawn, so the printed
// disc IS the one on screen — there is no second copy of that artwork that
// could fall out of step with it.
function emblemEl() {
  const src = document.querySelector('.sheet .emblem svg');
  return src ? src.cloneNode(true) : null;
}

// The tone legend: the twelve tones in semitone order, TONE_LETTER over
// TONE_MARK — the same two arrays buildTones() reads for the screen table, so
// the printed key cannot name a tone the sheet writes differently.
function drawTones(doc, x, y) {
  const w = TONE_CELL_W;
  doc.setDrawColor(...rgb(TONE_LINE));
  doc.setLineWidth(TONE_BORDER);
  for (let i = 0; i < TONE_LETTER.length; i++) {
    doc.setFillColor(...rgb(TONE_BG));
    doc.rect(x + i * w, y, w, TONE_ROW_H, 'FD');
    doc.rect(x + i * w, y + TONE_ROW_H, w, TONE_MK_H, 'FD');
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(TONE_PT);
  doc.setTextColor(...rgb(SHEET_INK));
  TONE_LETTER.forEach((letter, i) => {
    doc.text(letter, x + i * w + w / 2, y + TONE_ROW_H / 2 + capMM(TONE_PT) / 2,
      { align: 'center' });
  });

  // The noteheads, saying what the staff says: hollow for a natural, filled for
  // a lowered variant, a hollow triangle for M2.
  const my = y + TONE_ROW_H + TONE_MK_H / 2;
  doc.setDrawColor(...rgb(SHEET_INK));
  doc.setFillColor(...rgb(SHEET_INK));
  TONE_MARK.forEach((m, i) => {
    const cx = x + i * w + w / 2;
    if (m === 'o') {
      doc.setLineWidth(MK_O_W);
      doc.circle(cx, my, MK_O_R, 'S');
    } else if (m === 'f') {
      doc.circle(cx, my, MK_F_R, 'F');
    } else {
      // .mk-t draws polygon 6,1.2 11,9.8 1,9.8 in a 12x11 box, hollow.
      const sx = MK_T_W / 12, sy = MK_T_H / 11;
      const x0 = cx - MK_T_W / 2, y0 = my - MK_T_H / 2;
      doc.setLineWidth(MK_O_W);
      doc.triangle(
        x0 + 6 * sx, y0 + 1.2 * sy,
        x0 + 11 * sx, y0 + 9.8 * sy,
        x0 + 1 * sx, y0 + 9.8 * sy, 'S',
      );
    }
  });
}

// The four meta fields. Label and value are one piece of bold text with the
// value set META_VAL_GAP after the label, exactly as .metaline prints them; the
// right column is right-aligned so the two colons stack.
const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const keyName = () => KEY_NAMES[(((state.saMidi ?? 60) % 12) + 12) % 12];

function metaPair(doc, lab, val, baseline, right) {
  const lw = doc.getTextWidth(lab);
  const vw = doc.getTextWidth(val);
  const x = right ? RIGHT - vw - META_VAL_GAP - lw : LEFT;
  doc.text(lab, x, baseline);
  doc.text(val, x + lw + META_VAL_GAP, baseline);
}

// Draws the head. The first row starts under it, at PAGE_FIRST_Y.
async function drawHeader(svg2pdf, doc) {
  const top = SHEET_PAD_TOP;
  const tonesW = TONE_CELL_W * TONE_LETTER.length;
  const tonesH = TONE_ROW_H + TONE_MK_H;
  // The emblem's centre, the rule and the legend's midline all sit on one axis,
  // as .sheet-head's `align-items: center` puts them.
  const mid = top + HEAD_H / 2;

  const em = emblemEl();
  if (em) await placeSVG(svg2pdf, doc, em, LEFT, mid - EMBLEM_MM / 2, EMBLEM_MM, EMBLEM_MM);

  doc.setDrawColor(...rgb(SHEET_INK));
  doc.setLineWidth(HEAD_RULE_W);
  doc.line(LEFT + EMBLEM_MM, mid, RIGHT - tonesW, mid);

  drawTones(doc, RIGHT - tonesW, mid - tonesH / 2);

  const y = META_Y;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(META_PT);
  doc.setTextColor(...rgb(SHEET_INK));
  const base = y + META_LINE / 2 + capMM(META_PT) / 2;
  const base2 = base + META_LINE + META_GAP;
  metaPair(doc, 'Title :', state.title || 'Untitled', base, false);
  metaPair(doc, 'K.S. :', keyName(), base, true);
  metaPair(doc, 'Tempo :', String(state.bpm), base2, false);
  metaPair(doc, 'T.S. :', `${beatsPerBox()}/4`, base2, true);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

}

// ---------- the sheet foot ----------

// The page pill and the brand line, pinned to the foot of every page the way
// .pagenum and .brand are pinned to the foot of the sheet — not trailing the
// last row, so a short score still prints them where the layout puts them.
function drawFooter(doc, pageNum) {
  const x = (PAGE_W_MM - PILL_W_MM) / 2;
  const y = PAGE_H_MM - PILL_BOTTOM - PILL_H_MM;
  doc.setFillColor(...rgb(TONE_BG));
  doc.setDrawColor(...rgb(TONE_LINE));
  doc.setLineWidth(TONE_BORDER);
  doc.roundedRect(x, y, PILL_W_MM, PILL_H_MM, PILL_R_MM, PILL_R_MM, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(PILL_PT);
  doc.setTextColor(...GUTTER_INK);
  doc.text(String(pageNum), PAGE_W_MM / 2, y + PILL_H_MM / 2 + capMM(PILL_PT) / 2,
    { align: 'center' });

  doc.setFontSize(BRAND_PT);
  doc.setTextColor(...rgb(BRAND_COLOR));
  doc.text('© Lyptron', PAGE_W_MM - BRAND_RIGHT, PAGE_H_MM - BRAND_BOTTOM,
    { align: 'right' });
  doc.setTextColor(0);
  doc.setFont('helvetica', 'normal');
}

// ---------- the row gutter ----------

// The row number and the sthayi key, placed off the row's OWN geometry (`yMin`
// is where its SVG starts) so the square lands on the staff however far a tall
// row has grown. Every offset is the GUTTER_* constant the screen gutter uses,
// measured from the row SVG's left edge — which on the page is LEFT.
function drawGutter(doc, n, rowY, yMin) {
  const at = u => rowY + toMM(u - yMin);
  const numX = LEFT + toMM(GUTTER_NUM_X);
  const markX = LEFT + toMM(GUTTER_MARK_X);
  const triW = toMM(GUTTER_TRI_W) / 2;
  const triH = toMM(GUTTER_TRI_H);
  const sq = toMM(GUTTER_SQ);
  const numPt = toMM(GUTTER_NUM_SIZE) / 0.352;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(numPt);
  doc.setTextColor(...GUTTER_INK);
  doc.text(String(n), numX, at(MAGY) + capMM(numPt) / 2, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  doc.setFillColor(...GUTTER_INK);
  const up = at(TOPY - GUTTER_OUT), dn = at(BOTY + GUTTER_OUT);
  doc.triangle(markX, up - triH / 2, markX - triW, up + triH / 2, markX + triW, up + triH / 2, 'F');
  doc.rect(markX - sq / 2, at(MAGY + GUTTER_MID_OFFSET) - sq / 2, sq, sq, 'F');
  doc.triangle(markX, dn + triH / 2, markX - triW, dn - triH / 2, markX + triW, dn - triH / 2, 'F');
  doc.setFillColor(0, 0, 0);
}

export async function exportPDF() {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  const svg2pdf = window.svg2pdf && (window.svg2pdf.svg2pdf || window.svg2pdf);
  if (!jsPDF || !svg2pdf) {
    alert('PDF libraries failed to load.');
    return;
  }


  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const rows = scoreRows();

  // True size: one SVG unit is one unit, no page-fitting scale. The row is
  // exactly the sheet's content width — 18 cm of staff plus its bleed.
  const rowW = toMM(VW);

  await drawHeader(svg2pdf, doc);

  // pageLayout() is the screen's Page view rule too, so the two break alike.
  const at = pageLayout(rows);
  for (const [i, row] of rows.entries()) {
    const { page, y, h: rowH } = at[i];
    if (i && page !== at[i - 1].page) doc.addPage();
    drawGutter(doc, i + 1, y, rowExtent(row).yMin);
    const svgEl = svgFromString(rowSVG(row, null, null, false));
    await placeSVG(svg2pdf, doc, svgEl, LEFT, y, rowW, rowH);
  }

  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    drawFooter(doc, p);
  }

  const safe = (state.title || 'untitled').replace(/\s+/g, '_');
  doc.save(safe + '.pdf');
}
