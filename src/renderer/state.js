// Mutable application state. Imported as a singleton by every module
// that needs to read or mutate the current score / UI flags.

export const state = {
  // input mode
  mode: 'piano',   // 'piano' | 'keyboard' | 'midi'

  // current note-entry parameters
  oct: 0,         // -1 mandra, 0 madhya, 1 taara
  // How many piano keys the dock shows. 12 is the selected sthayi alone; a
  // wider span opens the neighbouring sthayis on either side so mandra and
  // taara can be played without leaving the tab you are on.
  pianoSpan: 17,
  // Which physical key writes which svara. Null until keybinds.js fills it
  // from localStorage (or from KEY_ROWS, the default layout) at startup.
  keyBinds: null,

  // ---- the connected MIDI keyboard --------------------------------------
  // Web MIDI reports no key count, so what gets drawn is worked out from the
  // device NAME, from a size picked in the dock, and from the notes actually
  // played. midi-input.js keeps these three up to date; piano.js reads them
  // and resolveDeviceRange() in midi-device.js turns them into a range.
  midiDeviceName: '',
  midiKeyOverride: null,          // a size chosen in the dock, or null = auto
  midiLearned: { low: null, high: null },
  midiListening: false,
  // Which physical keys are down RIGHT NOW, as midi note numbers. Published by
  // midi-input.js and read by piano.js when it draws the device, so a rebuild
  // in the middle of a hold redraws the held keys still lit — buildPiano()
  // rewrites the dock's markup, and a class toggled onto the old elements
  // would be thrown away with them. Same one-way arrangement as the fields
  // above: the input module publishes, the drawing module reads, and neither
  // imports the other.
  midiHeld: [],
  // Where PLAYBACK sounds. 'internal' is the recorded samples; 'device' sends
  // the score out to the connected instrument's own engine, which covers every
  // pitch natively instead of shifting two recorded octaves to reach the
  // middle one. Live keys are never echoed either way — the piano already
  // sounds the key under your finger. See midi-out.js.
  midiSink: 'internal',   // 'internal' | 'device'
  midiOutId: null,        // chosen output port, or null = the first one
  // Whether the app should match the keyboard's MIDI transport clock;
  // 'off' leaves the app metronome independent. See midi-clock.js.
  midiSync: 'follow',     // 'off' | 'follow'
  // Milliseconds to shift a MIDI-clock beat by, + late. Kept as a preference
  // for setups whose MIDI and audio paths have a measurable offset.
  midiSyncOffset: 0,
  // Has arriving clock actually been SEEN from this device, and what tempo is
  // it running at? Observed, like everything else about a keyboard here: a
  // device that sends no clock cannot be followed, and the dock says so rather
  // than leaving the player wondering why nothing happens.
  midiClockSeen: false,
  midiClockBpm: null,
  // Is that clock RUNNING right now? metronome.js reads it to stand its own
  // loop down while an external master is counting — two grids counting one
  // bar is not a sync, it is a flam.
  midiClockRunning: false,
  // Does the device announce its downbeat (Start/Continue), or only free-run
  // pulses? Free-run gives an exact tempo and an arbitrary bar position, so
  // the clicks are right and the ACCENT may not be. Reported in the dock.
  midiClockFree: false,
  // Has the player told us where the downbeat is? A free-running clock carries
  // no bar position at all, so this remains false until a real Start message
  // arrives. It is not score data or a setting.
  midiClockAligned: false,
  // Legacy tap-alignment state retained for settings/session compatibility.
  midiTapSynced: false,
  // How many taps are in the current run. One placed the BAR at the tempo
  // already set; two or more also took the TEMPO from the taps — and which of
  // those happened is what tells a player whether the number in the tempo
  // field is still the one they typed.
  midiTapCount: 0,
  // What the connected device has been OBSERVED to do, as opposed to what its
  // name suggests. Web MIDI reports no capabilities at all, so the only
  // evidence is what arrives: `midiVelocity` stays null until two DIFFERENT
  // velocities have been seen, which is the only proof a keyboard has a
  // velocity sensor rather than a fixed value it stamps on everything.
  midiVelocity: null,     // null = unknown, true = sensitive, false = fixed
  midiChannels: [],
  // The latched auto-centre shift, in octaves, and the device it was taken
  // for. deviceShift() in piano.js retakes it only when the key changes — see
  // the note there on why it must not follow the learned range.
  midiShift: 0,
  midiShiftKey: null,
  head: 'auto',    // 'auto' | 'f' (filled) | 'o' (hollow)
  sym: 'bindu',   // selected sound symbol

  // What decides a played note's VALUE. 'time' (the default) means how long
  // the key was held picks the symbol outright, so the whole ladder from danta
  // up to Maguru is reachable by playing. 'fixed' means the selected symbol IS
  // the value and nothing grows — pick bindu and every key writes a bindu,
  // however long it is held, which is what entering an even run wants.
  // 'palette' is the older rule, where the selected symbol is a FLOOR a hold
  // can only grow past — which with the default bindu selected made every
  // value shorter than one beat impossible to play, however briefly the key
  // was tapped. startHoldPromotion() in score.js is the one place all three
  // differ.
  holdWrites: 'time',   // 'time' | 'fixed' | 'palette'

  // the score itself
  notes: [],
  bars: [],
  // Manual line breaks, as box ordinals: a forced row break BEFORE that box.
  // Layout only — the music is untouched, so these live beside the score
  // rather than in it.
  breaks: [],

  // The break most recently placed or moved, as its box ordinal, or null.
  // A POINTER, not score data: it says where the user was last working, so the
  // sheet can mark that break out from the others and the arrow keys know
  // which one they move. It rides in the undo snapshot and in the tab's slice
  // — a pointer into another document's breaks would name the wrong division —
  // but NOT into the saved .json, because a piece does not carry where
  // somebody was editing it. render() drops it when it no longer names a
  // break that exists, which is what survives undo, load and clearAll().
  lastBreak: null,

  // The repeat mark currently selected on the sheet, by its bar id, or null.
  // Selection is what gates the Delete key: a brace is only removed by Delete
  // when one is picked, so the key still deletes the last NOTE otherwise.
  selBar: null,

  // playback
  playing: false,
  hlIndex: null,
  // Playing position in timing units — what the beat highlight follows.
  hlAt: null,
  bpm: 72,
  metroOn: false,
  metroSound: 0,

  // Who fills the silence left in a box. 'auto' derives pad rests at render
  // time; 'metro' records real rests from metronome ticks instead and leaves
  // the staff blank where nothing was played. Mutually exclusive.
  fill: 'auto',   // 'auto' | 'metro'

  // tala / scale / tonic
  // The metre, by key into timesig.js's registry (builtins + custom). It is
  // what says how many beats a division holds, so it is real layout state now
  // rather than a caption. CHATUSRA is the plain 4 the staff has always drawn.
  tala: 'chatusra',
  saMidi: 60,      // MIDI note number of Sa (60 = middle C). Set by piano's Sa picker.

  // ui
  // Which sidebar tool is armed for a click on the sheet. null is the normal
  // state (clicks inspect a glyph); 'break' arms the Break tool and 'repeat'
  // the two-click repeat tool. One field, so the two cannot both be listening.
  tool: null,
  // The ×2/×3/×4 the armed repeat tool will write. Null when it is not armed.
  repeatCount: null,
  zoom: 1,
  // Legend: write each note's svara name beside its goli, on the sheet itself.
  // Off by default — it is a reading aid, not part of the notation.
  showNames: false,
  sys: 'DNG',     // 'DNG' uses English svara labels, 'DNR' uses regional script
  lang: 'en',
  pageView: true,

  // The signed-in person, as the backend describes them, or null when nobody
  // is. Written only by auth.js, which announces every change as an
  // 'auth:changed' document event — read it, do not set it. It is NOT part of
  // a document: it never enters snapshot(), a tab's slice, or the saved .json,
  // because who was logged in is not a property of the music.
  user: null,

  // metadata
  title: 'Untitled',
  preset: null,

  // history
  hist: [],
  future: [],

  // cowork (mock for now)
  cwRole: 'teacher',
};

// Open documents shown as tabs. Each entry stores a slice of the state.
export const docs = [];
export let activeDoc = 0;
export function setActiveDoc(i) { activeDoc = i; }
export function getActiveDoc() { return activeDoc; }

export function snapshot() {
  return JSON.stringify({
    notes: state.notes, bars: state.bars, breaks: state.breaks,
    // Undo has to put the pointer back with the break it names, or undoing a
    // move leaves the sheet marking a division the break is no longer at.
    lastBreak: state.lastBreak,
    // The metre decides how big a division is, so changing it re-lays the
    // whole score — undo has to be able to put it back.
    tala: state.tala,
  });
}
