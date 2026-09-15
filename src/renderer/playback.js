// Playback transport.
//
// Notes are scheduled AHEAD on the AudioContext clock, not started when a timer
// fires. A timer shares its thread with the score redraw — which costs 13ms at
// 400 notes and 25ms at 700 — so timer-started onsets measured 7.5ms late on
// average, 15ms at worst, against a 125ms grid. That wobble is what a run of
// short symbols sounds like when it will not sit still. Scheduled ahead, the
// onset is sample-accurate however busy the frame is.
//
// One loop drives both: it schedules the audio a window in advance and moves
// the highlight to whatever the audio clock says is sounding NOW, so the blue
// box follows what you hear rather than running on a clock of its own.

import { state } from './state.js';
import { SVARAS, TIME_UNITS_PER_BEAT, beatSeconds } from './config.js';
import { pluckAt, freqOf, midiNoteOf, heldLength, audioNow, stopSustain } from './audio.js';
import {
  deviceSink, sendNoteAt, allNotesOff,
  clockSink, sendClockAt, sendClockStart, sendClockStop,
} from './midi-out.js';
import { semiOf } from './config.js';
import { render, expandScore } from './notation.js';
import { resolveMark } from './repeat-model.js';
import { clickForBeat, stopScheduledClicks, stopDriving } from './metronome.js';
import {
  newClockSender, anchorClockSender, clockSenderRunning, stopClockSender, pumpClockOut,
} from './midi-clock.js';
import { beginFollow, endFollow, followPlayhead } from './follow.js';

// How often the loop runs, and how far ahead of the audio clock it schedules.
// The window has to comfortably cover the gap between runs plus any frame the
// redraw might block for.
const TICK_MS = 25;
const SCHEDULE_AHEAD = 0.15;
// Enough of a delay before the first note that the first window is scheduled
// ahead of the clock like every other one.
const LEAD_IN = 0.08;

let timer = null;
let voices = [];
// The beat clock this transport sends out when the app is leading. Module
// level, like `timer`, because stopPlay() has to be able to end the train
// from outside the pump that started it. See midi-clock.js.
const sender = newClockSender();

// Expand the score across multiple (sequential, non-nested) open/close
// repeat pairs. Each `close` pairs with the latest preceding `open`; if
// there isn't one, the open is implicit at the previous close (or 0).
export function buildPlaySeq() {
  // Play the expanded score so the rests that pad a partly-filled box are
  // heard as real silence. `i` stays the index in state.notes (null for a
  // derived rest) so the highlight still lines up with what the user typed.
  const score = expandScore();
  const items = score.notes.map((n, k) => ({ n, i: score.sourceIndex[k], at: score.unitAt[k] }));
  const bars = score.bars.slice().sort((a, b) => a.unit - b.unit);
  if (!bars.length) return items;

  // A mark sits on the clock and may have been dropped anywhere, so playing it
  // means cutting at a real glyph boundary. It cuts at the NEAREST one — the
  // same one the staff drew the brace at — rather than at the next one along.
  //
  // Rounding forward was wrong at both ends and wrong in opposite directions:
  // a closing brace sitting on a note pulled that whole note into the loop,
  // and an opening brace sitting on a note pushed it out of one. Reading the
  // sheet, the brace is beside the note its ink is nearest, and that is now
  // the note the loop starts on and the note it stops before.
  // The glyphs as spans of the clock — the same list entryCells() gives the
  // staff, so a brace sounds from exactly the note it is drawn over.
  const cells = items.map(it => ({
    at: it.at,
    units: Math.round((Number(it.n.dur) || 0) * TIME_UNITS_PER_BEAT),
  }));

  const indexAt = (unit, kind) => {
    const at = resolveMark(unit, kind, cells);
    const i = items.findIndex(it => it.at >= at - 1e-9);
    return i < 0 ? items.length : i;
  };

  const opens = bars.filter(b => b.kind === 'open');
  const closes = bars.filter(b => b.kind === 'close');
  if (!closes.length) return items;

  // Pair each close with the latest preceding open (or implicit open = prev close / 0).
  const pairs = [];
  let oi = 0;
  let implicitOpen = 0;
  for (const close of closes) {
    let openAt = implicitOpen;
    while (oi < opens.length && opens[oi].unit <= close.unit) {
      openAt = indexAt(opens[oi].unit, 'open');
      oi++;
    }
    const closeAt = indexAt(close.unit, 'close');
    pairs.push({ openAt, closeAt, cnt: close.count || 2 });
    implicitOpen = closeAt;
  }

  let seq = [];
  let prev = 0;
  for (const p of pairs) {
    // unrepeated prefix between previous close and this open
    seq = seq.concat(items.slice(prev, p.openAt));
    // repeat the section [open..close] cnt times
    const seg = items.slice(p.openAt, p.closeAt);
    for (let r = 0; r < p.cnt; r++) seq = seq.concat(seg);
    prev = p.closeAt;
  }
  return seq.concat(items.slice(prev));
}

function setPlayIcon(playing) {
  const el = document.getElementById('playIcon');
  el.innerHTML = playing
    ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

export function startPlay() {
  const seq = buildPlaySeq();
  if (!seq.length) return;
  state.playing = true;
  setPlayIcon(true);
  // Follow again from the top, whatever the last run ended up scrolled to: a
  // scroll by hand yields for that playthrough only.
  beginFollow();

  // The keyboard's metronome follows the SCORE from here, not the standalone
  // count. metronome.js's loop already stands down under playback, and its
  // pulse train has to go with it — two trains on one wire is a device
  // counting at double speed. Handed over HERE rather than from inside that
  // loop, which runs up to a tick later and would stop the train this one is
  // about to start.
  stopDriving();

  let next = 0;                       // next item to SCHEDULE
  let when = audioNow() + LEAD_IN;    // audio-clock time of seq[next]
  const times = [];                   // when each item starts, for the highlight
  let shown = -1;                     // item the highlight is on
  let shownAt = null;

  // The metronome's grid, anchored to the SAME origin as the notes and
  // advanced in the same pump off the same beatSeconds(). That is what
  // makes the click land on the note instead of near it: there is one clock,
  // one origin and one tempo read, so there is nothing for the two to drift
  // against. Beat 0 is the first beat of the score, so `beat % beatsPerBox()`
  // accents the metre's group starts where the division lines actually are.
  //
  // The grid advances whether or not the metronome is switched on, so turning
  // it on part-way through joins the count in the right place rather than
  // restarting it at 1 under the middle of a bar.
  let clickWhen = when;
  let clickBeat = 0;

  const pump = () => {
    const now = audioNow();

    // Schedule everything that begins inside the window. bpm is read here, so a
    // tempo change still applies — from the first note not yet scheduled, which
    // is at most one window away.
    while (next < seq.length && when < now + SCHEDULE_AHEAD) {
      const { n } = seq[next];
      const beat = beatSeconds(state.bpm);
      // `tie` marks the tail of a note split across a box edge — it keeps its
      // time but must not sound a second attack. The one attack it does get
      // rings for the joined length (`full`), not just the head's share.
      if (n.type === 'note' && !n.tie) {
        const semi = semiOf(n.svaraIndex, n.head);
        // The WRITTEN length. audio.js holds the note for exactly this and
        // rings it out afterwards, so what is passed here is the value on the
        // page and not the value plus its tail — see strike().
        const secs = heldLength(n.full || n.dur || 1, state.bpm);
        // One sink or the other, never both — the samples and the instrument
        // playing the same line together is a chorus, not a louder note.
        // deviceSink() is false when no output port exists, so unplugging the
        // piano mid-score falls back to the samples rather than going silent.
        if (deviceSink()) {
          // The written value: the ring-out is a property of a decaying
          // sample, and asking the instrument to hold the note that much
          // longer would blur every run. `vel` is what was actually
          // played, defaulting to a normal strike for notes that never carried
          // one (typed, clicked, or played on a keyboard with no sensor).
          const beat = beatSeconds(state.bpm);
          sendNoteAt(midiNoteOf(semi, n.oct), n.vel || 100, when,
            (n.full || n.dur || 1) * beat);
        } else {
          const voice = pluckAt(freqOf(semi, n.oct), secs, when);
          if (voice) voices.push(voice);
        }
      }
      times[next] = when;
      when += (n.dur || 1) * beat;
      next++;
    }

    // The outgoing beat clock, on the same grid as the clicks and laid down
    // in the same window — see midi-clock.js. Anchored to `clickWhen`, which
    // is the next beat not yet counted, so switching sync on part-way through
    // a score starts the instrument on the next downbeat instead of on one
    // that has already gone past.
    if (clockSink()) {
      if (!clockSenderRunning(sender)) {
        sendClockStart(clickWhen);
        anchorClockSender(sender, clickWhen);
      }
      pumpClockOut(sender, now, SCHEDULE_AHEAD, () => beatSeconds(state.bpm), sendClockAt);
    } else if (clockSenderRunning(sender)) {
      stopClockSender(sender);
      sendClockStop();
    }

    // Clicks for the same window. `when` is now the end of everything
    // scheduled so far, so the second test stops the count at the end of the
    // music rather than ticking on over the silence after it.
    while (clickWhen < now + SCHEDULE_AHEAD && (next < seq.length || clickWhen < when)) {
      if (state.metroOn) clickForBeat(clickBeat, clickWhen);
      clickBeat += 1;
      clickWhen += beatSeconds(state.bpm);
    }

    // Move the highlight to whatever is sounding now.
    let at = shown;
    while (at + 1 < times.length && times[at + 1] <= now) at++;
    if (at >= 0) {
      const item = seq[at];
      // A note longer than a beat holds one sound, but the highlight still
      // walks the beats underneath it, so the box keeps time with the pulse.
      const beats = Math.min(
        Math.floor((now - times[at]) / beatSeconds(state.bpm)),
        Math.max(0, Math.floor(item.n.dur || 1) - 1),
      );
      const hlAt = item.at + beats * TIME_UNITS_PER_BEAT;
      if (at !== shown || hlAt !== shownAt) {
        shown = at;
        shownAt = hlAt;
        state.hlIndex = item.i;
        state.hlAt = hlAt;
        render();
        // After the redraw, so the row the highlight just moved into is the one
        // on the page to measure. Costs nothing on the beats that stay in it.
        followPlayhead();
      }
    }

    if (next >= seq.length && now >= when) stopPlay();
  };

  timer = setInterval(pump, TICK_MS);
  pump();
}

export function stopPlay() {
  state.playing = false;
  clearInterval(timer);
  timer = null;
  // Before the final render(), so the frame that clears the highlight cannot
  // also be chased by a scroll aimed at a row that is no longer active.
  endFollow();
  // Silence anything already scheduled — some of it has not started yet.
  for (const voice of voices) stopSustain(voice);
  voices = [];
  // Notes sent to the instrument are queued on ITS clock, so clearing our own
  // scheduler cannot recall them: without this the keyboard plays on after the
  // transport goes dark. Called unconditionally — the sink may have been
  // switched, or the port unplugged, since the notes went out.
  allNotesOff();
  // Including the clicks: up to SCHEDULE_AHEAD of them are on the clock, and
  // they would otherwise keep ticking after the transport stopped.
  stopScheduledClicks();
  // And the beat clock, for the same reason and one worse: a pulse train left
  // running does not merely tick on, it keeps the instrument's own metronome
  // counting a score that has finished.
  if (clockSenderRunning(sender)) {
    stopClockSender(sender);
    sendClockStop();
  }
  state.hlIndex = null;
  state.hlAt = null;
  render();
  setPlayIcon(false);
}

export function togglePlay() {
  if (state.playing) stopPlay(); else startPlay();
}
