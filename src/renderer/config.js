// ---------- Product identity ----------
//
// The one place the product names itself. The window title, the document
// title, the menubar lockup and the About box all read these, so the app
// cannot introduce itself by one name in the titlebar and another in a
// dialog. The logo files beside them are generated from assets/IYDANI.jpeg
// (see brand/README.txt) — the JPEG is the source of record, these are the
// keyed, transparent-background derivatives the UI actually loads.
export const APP_NAME = 'IYDANI';
export const APP_DESCRIPTOR = 'SCORER';
export const APP_TAGLINE = 'Write - N - Read - N - Play';
export const APP_TITLE = `${APP_NAME} ${APP_DESCRIPTOR}`;
export const APP_VENDOR = 'Lyptron';
export const BRAND_MARK = './brand/iydani-mark.svg';
export const BRAND_LOCKUP = './brand/iydani-lockup.png';

// ---------- Music-domain constants ----------

export const SA_FREQ = 261.63;
export const BPM = 60;

// How long one beat lasts, in seconds — the single answer to "what is the
// tempo", used by the playback transport, the metronome and the hold-promotion
// clock alike.
//
// The guard is not decoration. `60 / 0` is Infinity and `60 / undefined` is
// NaN, and either one poisons the scheduler: every `when` after it is
// Infinity/NaN, `when < now + SCHEDULE_AHEAD` can never be true again, so no
// further note is ever scheduled AND the "have we reached the end" test never
// fires either — the transport sits playing forever, silent, with nothing left
// that can move it on. A tempo field cleared mid-edit is enough to do it.
export function beatSeconds(bpm = null) {
  const n = Number(bpm);
  return 60 / (Number.isFinite(n) && n > 0 ? n : BPM);
}
export const MIN_BPM = 20;
export const MAX_BPM = 240;
export const MAX_HIST = 120;

export const COL = [
  'var(--c-sa)', 'var(--c-ri)', 'var(--c-ga)', 'var(--c-ma)',
  'var(--c-pa)', 'var(--c-da)', 'var(--c-ni)', 'var(--c-sa)',
];

// The seven ladder positions, plus Sá to close the octave. `semi` is the
// Mayamalavagowla reading of each — the scale the sheet header names — and
// `filled` is the notehead a preset gets when it does not say. Keyboard entry
// does NOT read `semi`: it goes through SVARA_TONES below, where each position
// carries both its natural and its chromatic variant.
//
// Key assignment used to live here, one InScript letter per svara. It now lives
// in KEY_ROWS, because the map is positional — the row is the sthayi — rather
// than one letter per svara name.
export const SVARAS = [
  { semi: 0,  filled: false, full: 'Shadja' },
  { semi: 1,  filled: true,  full: 'Rishabha' },
  { semi: 4,  filled: false, full: 'Gandhara' },
  { semi: 5,  filled: false, full: 'Madhyama' },
  { semi: 7,  filled: false, full: 'Panchama' },
  { semi: 8,  filled: true,  full: 'Dhaivata' },
  { semi: 11, filled: false, full: 'Nishada' },
  { semi: 12, filled: false, full: 'Shadja+' },
];

// ---------- Keyboard map ----------
//
// Three physical letter rows, one per sthayi, seven keys each. Reading straight
// across a row gives S R G M P D N, so a scale is one finger-walk and the row
// you are on IS the octave — no octave state to track while typing.
//
//   TAARA   Q W E R T Y U      (I O P free)
//   MADHYA  A S D F G H J      (K L free)
//   MANDRA  Z X C V B N M      (, . stay on octave UI)
//
// A plain press writes the NATURAL svara with a hollow goli; Shift writes the
// chromatic VARIANT with a filled goli. Sa and Pa have no variant, so Shift on
// those is a no-op rather than writing the wrong note.
//
//   7 naturals + 5 variants = the full 12 tones, in each of 3 sthayis:
//   21 + 15 = 36 notes reachable without leaving the letter keys.
export const KEY_ROWS = [
  { oct:  1, keys: 'qwertyu' },   // taara  — higher octave
  { oct:  0, keys: 'asdfghj' },   // madhya — middle octave, home row
  { oct: -1, keys: 'zxcvbnm' },   // mandra — lower octave
];

// The physical keyboard the key map draws. Every cap is here, not just the
// bound ones, because the map is a picture of the keyboard in front of you —
// finding the key your finger is over is the whole point of it, and that only
// works if the unbound keys are drawn too.
//
// `k` is the character a cap binds by (null = a modifier, never bindable) and
// `u` is its width in key units; every row sums to 15u, which is what makes
// the stagger come out right at any size.
// (The backtick and apostrophe caps are written as escapes on purpose: a bare
// one of either inside a string literal derails any scanner that strips
// strings by regex, tools/check-imports.mjs included.)
export const KEYBOARD_LAYOUT = [
  [['\u0060'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['0'],
   ['-'], ['='], [null, 'Backspace', 2]],
  [[null, 'Tab', 1.5], ['q'], ['w'], ['e'], ['r'], ['t'], ['y'], ['u'], ['i'],
   ['o'], ['p'], ['['], [']'], [null, '\\', 1.5]],
  [[null, 'Caps', 1.75], ['a'], ['s'], ['d'], ['f'], ['g'], ['h'], ['j'], ['k'],
   ['l'], [';'], ['\''], [null, 'Enter', 2.25]],
  [[null, 'Shift', 2.25], ['z'], ['x'], ['c'], ['v'], ['b'], ['n'], ['m'],
   [','], ['.'], ['/'], [null, 'Shift', 2.75]],
  [[null, 'Ctrl', 1.25], [null, 'Alt', 1.25], [' ', 'Space', 10],
   [null, 'Alt', 1.25], [null, 'Ctrl', 1.25]],
];

// Per svara position: the natural semitone, and the chromatic variant reached
// with Shift (null where there is none). Note Ma's variant is SHARP — prati
// madhyama, a semitone UP — while the other four variants are flat.
//
//   natural   S 0   R 2   G 4   M 5   P 7   D 9   N 11
//   variant   —     r 1   g 3   m 6   —     d 8   n 10
export const SVARA_TONES = [
  { natural: 0,  variant: null },   // Sa
  { natural: 2,  variant: 1 },      // Ri
  { natural: 4,  variant: 3 },      // Ga
  { natural: 5,  variant: 6 },      // Ma  — variant is the sharp one
  { natural: 7,  variant: null },   // Pa
  { natural: 9,  variant: 8 },      // Da
  { natural: 11, variant: 10 },     // Ni
];

// What semitone a WRITTEN note sounds. A filled goli means the chromatic
// variant was written, a hollow one the natural — the same resolution the
// renderer uses to pick which head to DRAW, so what a note is named, what it is
// drawn as and what it sounds cannot disagree. Sa and Pa have no variant and
// always sound natural.
//
// It lives here rather than in audio.js because it is notation, not sound: the
// staff reads it to letter a note, and playback reads it to pitch one.
// Whether a note is written with a FILLED goli, resolving `head: 'auto'` (and
// anything else that is neither 'o' nor 'f') the way notation.js draws it. One
// question, one answer: the rule had four copies and one of them read auto as
// hollow, which struck Ri and Da alone — the only two svaras the base scale
// takes the lowered form of — and sounded a note the staff was not drawing.
export function isFilled(svaraIndex, head) {
  if (head === 'f') return true;
  if (head === 'o') return false;
  const sv = SVARAS[svaraIndex];
  return !!(sv && sv.filled);
}

// Whether this svara HAS a second form at all. Sa and Pa do not, so a gesture
// that flips the notehead is a no-op on them rather than writing a filled goli
// that would sound the same note it was drawn to contradict.
export function hasVariant(svaraIndex) {
  const tone = SVARA_TONES[svaraIndex];
  return !!(tone && tone.variant != null);
}

export function semiOf(svaraIndex, head) {
  const tone = SVARA_TONES[svaraIndex];
  const sv = SVARAS[svaraIndex];
  if (!tone) return sv ? sv.semi : 0;
  return isFilled(svaraIndex, head) && tone.variant != null ? tone.variant : tone.natural;
}

// ---------- Instruments: the recorded note samples ----------
//
// Which recordings the notes are played on is a PREFERENCE (`instrument` in
// settings.js), picked from the toolbar. Each entry below is everything that
// differs from one set to the next, so adding a set is a folder of
// n<midi>.wav files plus one row here:
//
//   dir     the folder under renderer/samples/, served over the app's own
//           `dng:` scheme (see src/main.js) because Chromium will not fetch
//           file:// URLs from a file:// page
//   cents   how far each recording is off A=440, MEASURED by
//           tests/audio.test.mjs's autocorrelation — its keys are the notes
//           the set has. Corrected on playbackRate per recording, so a stray
//           one (the Steinway's D4 is +20) is fixed without moving the rest.
//           A replaced file that no longer matches its row fails that test.
//   attack  how long a note fades in, s (never more than half a short note)
//   toneHz  a lowpass on the notes' master bus, 0 = off (the metronome does
//           not go through it)
//   fadeAt  when a sounding voice is taken down to silence, s — see
//           HELD_FADE_T
//
// Every file is 48 kHz mono 16-bit, peak -3 dBFS, named by the MIDI note it
// sounds. The two pianos are trimmed to 8 s with a 0.5 s fade, and are ONE
// channel of the stereo original, not a mix: both were recorded on spaced
// microphones whose channels run up to -0.85 out of phase, and the mix
// cancelled part of every note, which made them hollow.
export const INSTRUMENTS = [
  {
    // The app's own recordings: 24 plucked strikes, C3-B3 and C5-B5. The middle
    // octave was never recorded and is shifted from up to 6 semitones away.
    // Each strike starts hard and bright and dies inside a second, reported
    // from the field as "thap thap" and a metallic "tan" on every note; the
    // 80 ms fade-in and 1500 Hz lowpass soften it (picked by ear from A/B
    // renders), and fadeAt 0.5 takes away the residue each one sits on.
    id: 'original', name: 'Original', dir: 'original',
    cents: { 48: 1.3, 49: 6.4, 50: 5.4, 51: 6.6, 52: 4.2, 53: 2.5, 54: 8.8, 55: 3.8, 56: 6.7, 57: 8.8, 58: 9.7, 59: 7.6,
      72: 5.5, 73: 8.0, 74: 4.0, 75: 1.9, 76: 6.5, 77: 8.8, 78: 4.0, 79: 4.8, 80: 4.1, 81: 9.6, 82: 6.5, 83: 4.6 },
    attack: 0.08, toneHz: 1500, fadeAt: 0.5,
  },
  {
    // Salamander Grand Piano, a Yamaha C5 (Alexander Holm, CC-BY 3.0 — the
    // credit is samples/salamander/CREDITS.txt), one note every minor third
    // C3-C6 from the subset Tone.js hosts. A piano's hammer IS its attack, so
    // the pianos take only a 10 ms fade-in and no filter, and they decay by
    // themselves, so the fade only meets a key held past 6 s.
    id: 'salamander', name: 'Grand piano (Yamaha)', dir: 'salamander',
    cents: { 48: -2.8, 51: 3.6, 54: 1.2, 57: 5.6, 60: 4.6, 63: 8.4, 66: 3.0, 69: 7.2, 72: 9.9, 75: 13.0, 78: 4.8, 81: 8.0, 84: 8.0 },
    attack: 0.01, toneHz: 0, fadeAt: 6,
  },
  {
    // Splendid Grand Piano, a Steinway Akai released into the public domain
    // (github.com/sfzinstruments/SplendidGrandPiano). The mezzo-forte layer,
    // a recording every one or two semitones C3-C#6, so nothing is shifted
    // more than one. Clearer and crisper than the Yamaha.
    id: 'steinway', name: 'Grand piano (Steinway)', dir: 'steinway',
    cents: { 48: 10.4, 50: 13.8, 52: 9.6, 53: 10.6, 55: 8.5, 56: 12.2, 57: 12.2, 58: 12.6, 59: 13.6, 60: 9.5, 62: 10.0,
      64: 9.1, 65: 11.7, 67: 8.5, 69: 11.8, 71: 9.6, 72: 6.2, 74: 20.3, 76: 6.1, 77: 10.5, 79: 7.0, 80: 7.1, 81: 7.2,
      82: 8.8, 83: 6.2, 85: 7.3 },
    attack: 0.01, toneHz: 0, fadeAt: 6,
  },
];

// What a new install opens on, and what an unknown saved id falls back to.
// The Steinway, at the user's choice; the original set is one click away.
export const DEFAULT_INSTRUMENT = 'steinway';
export const instrumentById = id => INSTRUMENTS.find(i => i.id === id) || INSTRUMENTS.find(i => i.id === DEFAULT_INSTRUMENT);
export const sampleUrl = (inst, midi) => `dng://samples/${inst.dir}/n${midi}.wav`;

// Every file is peak-normalised to -3 dBFS on conversion, so this is just the
// playback trim.
export const SAMPLE_GAIN = 0.55;

// ---------- Concert pitch ----------
//
// No recording here is at A=440. The original set is +1.3 to +9.7 cents, the
// Steinway +6 to +20. It is inaudible against the set itself — a sample set
// only ever heard against itself is in tune with itself — and NOT inaudible
// against a LIVE keyboard: 6 cents at middle C is a ~0.9 Hz beat, the slow
// wobble that reads as "these two do not match" on any held note. So each
// recording is pulled onto concert pitch by its own `cents` entry, on
// playbackRate only; which recording plays is still chosen from the note's
// true pitch, so nearestSample() is unaffected.

// ---- sustain ----
//
// The recordings are single PLUCKED strikes and they die fast. Measured against
// each file's own peak, the set is 5-19 dB down half a second in and 19-31 dB
// down after one second. At 120 bpm half a second is ONE BEAT, so a bindu, a
// bindu chukki, a guru and a five-beat joined note all made the same sound: one
// pluck, gone inside a beat. Written duration decided when the NEXT note
// started and nothing else, which is why a chukki could not be heard as a
// chukki and a joined note sounded like only its first beat.
//
// A sampler answers this with a sustain loop, and this set takes one well: the
// tail is strongly periodic (0.985-1.000 correlation at one period's lag across
// all 24 files), so a region of whole periods can be repeated with no phase
// break. SAMPLE_LOOP_AT is where it is taken from — late enough to be past the
// attack transient, early enough that the note is still carrying real level
// (-4 to -7 dB in the low octave, -10 to -20 dB in the high one, which is the
// instrument's own balance and is left alone).
export const SAMPLE_LOOP_AT = 0.40;

// Whether playback takes that loop at all. OFF: a played note is the recording
// played once, exactly as a held key is, so it fades the way the instrument
// does and a long note is not held up past the ~1 s the recording carries.
//
// The loop was reported as a ring three separate ways — on a held key, at the
// end of a long hold, and at the end of every beat in playback — and each
// correction to its level or its tone moved the complaint without answering
// it, because what is heard is not how loud the loop is but that it does not
// CHANGE. A held key was cured by taking the loop away, and the same report
// then came back for playback alone, which was the one voice still looping.
// Decided once, at decode time: with this off no loop is ever built, so every
// `loops.get()` downstream finds none.
//
// This is the knob if long notes are wanted held again — at the cost of the
// ring, which is the same thing.
export const SAMPLE_SUSTAIN_LOOP = false;

// The shortest loop that may be taken, in seconds, rounded UP to whole periods.
// Much shorter and the repetition rate lands in the audible range and the note
// takes on a metallic ring of its own; much longer and more of the natural
// decay is inside the loop, which is what the flattening then has to undo.
export const SAMPLE_LOOP_MIN = 0.12;

// A live key that never gets its release — a missed MIDI note-off — used to go
// quiet on its own because the recording ran out. A looped voice would drone
// instead, so every sustained voice carries a hard stop this far out. It is
// long enough that no real hold reaches it.
export const SAMPLE_SUSTAIN_MAX = 30;

// From an instrument's `fadeAt` a voice is taken on down to silence, with this
// time constant. The original set needs it at 0.5 s: its recordings do not
// finish dying — a residue SITS at about -36 dB until the file's own fade,
// heard as a small buzz after every note. The pianos decay by themselves over
// their 8 s, so for them the fade only meets a key held past 6 s.
export const HELD_FADE_T = 0.6;

// ---- what a HELD note does after the loop takes over ----
//
// The loop solved a note dying inside a beat and introduced a different fault:
// it holds. Past SAMPLE_LOOP_AT the voice sat at a FIXED level with a FROZEN
// spectrum for as long as the key was down, which no struck string does, and
// the freezing is audible in its own right. Measured on the shipped set: within
// one pass of the loop the fundamental is steady to 0.1-3 dB, but every audible
// upper partial — those within 30 dB of the loudest — swings 5 to 24 dB, and
// that pattern then repeats EXACTLY at the loop rate, ~8.5 times a second. The
// loudness never moves, so the artefact is not heard as a tremolo or a tick;
// it is heard as roughness, in the flutter band the ear is most sensitive to.
//
// It is not a loop that was cut badly, and re-cutting it does not help. Nine
// configurations were measured — loop point 0.40/0.80/1.20/1.60s, length
// 25-400ms, crossfade from one period up to half the loop — and the worst-case
// swing stayed between 26 and 32 dB in every one of them. The swing is not
// decay across the region, which better flattening would cancel; it is the
// beating between the instrument's own partials, and that is there at every
// timescale a loop could be taken at.
//
// So the frozen hold is what gets fixed instead. A held voice DECAYS towards
// SUSTAIN_FLOOR and DARKENS towards its tone target, both slowly, which is what
// the recorded instrument does and which keeps the loop's contents moving
// underneath the ear rather than repeating into a stationary tone. Nothing here
// branches on a note's length: with these time constants a danta loses ~6% of
// its level and almost none of its top, so short notes are untouched and only a
// note held long enough to reach the loop is shaped by it.
//
// The numbers are set BY EAR against rendered A/B holds, not by a metric — the
// modulation-depth figure for the frozen loop is only 3.7% averaged across
// auditory bands, which underrates what the flutter actually sounds like.

// Where the slow decay heads, as a fraction of the note's struck level, and how
// fast it gets there. ~9 dB down over three seconds.
//
// The floor is ZERO, and that is the whole point of it. It was 0.28, which made
// a held note settle at just over a quarter of its struck level and STAY there
// for as long as the key was down — so a long hold ended in an endless, dark,
// quiet loop, reported from the field as a buzz at the end of a long note. That
// is the same frozen loop as before, only quieter: darkening and dropping the
// level does not remove a stationary tone, it just strips the richness that was
// covering it, which is why the first correction moved the complaint rather
// than answering it.
//
// A struck string does not settle anywhere. This set is 19-31 dB down one
// second in and gone inside three, so a held note that fades all the way out is
// what the instrument actually does — and it disposes of the endless tail by
// construction rather than by chasing whatever the tail happened to sound like.
// The time constant keeps the three-second shape the sound was judged on
// (-9.0 dB) while carrying on down: -24 dB at 8 s, -45 dB at 15 s.
//
// Short symbols are still untouched, which is what a floor was wrongly being
// used to guarantee: a danta at 120bpm is 0.125 s and loses 4%.
export const SUSTAIN_FLOOR = 0;
export const SUSTAIN_DECAY_T = 2.9;

// SUSTAIN_DECAY_T is the SLOWEST a played note decays, not the rate of every
// one. It was set against three-second holds, and under a one-beat note it is
// no decay at all: measured at 72 bpm, a madhya note's pluck fell 6 dB in its
// first 0.35 s and then sat within 1.5 dB until the beat ended, 11-17 dB above
// where the recording itself would have been — a flat tone on the back half of
// every beat, reported from the field as a ring at the end of each one. So the
// decay through the loop takes its time constant from the NOTE: the length of
// its sustained part (audio.js, sustainDecayT), which lands every note ~9 dB
// down at its written end whatever it is worth. A bindu dies across its beat
// like the pluck it is; a guru is still sounding through its second.
// Floored here, at about the recording's own rate just past the loop point, so
// a note only slightly longer than the pluck is not dropped off a cliff.
// This is the knob if a short note dies too soon or still rings.
export const SUSTAIN_DECAY_MIN_T = 0.35;

// The progressive darkening, as a lowpass that falls from FROM to TO with time
// constant SUSTAIN_TONE_T. The flutter lives in the upper partials, so rolling
// them off is what removes it, and a real string loses them anyway.
//
// Both ends are held clear of the note's OWN pitch. A flat 900 Hz target reads
// correctly under the low and middle octaves, where it was judged, and would
// sit BELOW the fundamental of a taara Ni at 988 Hz — cutting the note away
// rather than darkening it. Taking the greater of the fixed target and a
// multiple of the note's own frequency keeps the approved sound where it was
// approved and degrades gracefully above it.
export const SUSTAIN_TONE_T = 1.2;
export const SUSTAIN_TONE_FROM_HZ = 8000;
export const SUSTAIN_TONE_TO_HZ = 900;
export const SUSTAIN_TONE_FROM_RATIO = 6;
export const SUSTAIN_TONE_TO_RATIO = 2.2;

// ---------- How long a struck note is heard ----------
//
// A played note is HELD for its whole written value and released AFTER it,
// over a short tail that crossfades into the next note's attack — legato.
//
// Two rules were tried before this and each was reported from the field. A
// ring carried 0.5–0.9 s past the written end ran every danta and praya into
// the ones after it, so a run read as rushed and blurred. Carving the release
// out of the note's OWN length instead left every note faded to dead silence
// (measured −70 to −86 dB) 20–40 ms before the next onset, so a melody played
// as a string of separate "thap thap" strikes rather than as a line.
//
// So the tail is as long as the note itself (RELEASE_SHARE 1), never more than
// RELEASE_MAX_SECONDS. A danta at 72 bpm (0.104 s) fades over 0.104 s into the
// next note, in a straight line, so it stays near full while the next note
// fades in (an exponential tail dipped ~9 dB at every note change). Half the
// note, capped at 0.15 s, was tried first and still reported as too choppy. A
// repeated pitch crossfades into itself over the new note's fade-in, in
// damp(). A released live key
// fades over RING_MIN_SECONDS. These are the knobs if notes sound too dry
// (raise them) or smeared (lower them).
export const RING_MIN_SECONDS = 0.5;
export const RELEASE_SHARE = 1;
export const RELEASE_MAX_SECONDS = 0.4;

// The output buffer the AudioContext asks for. The default ('interactive')
// takes Windows' shared-mode path: measured here, 42 ms from a key going down
// to it being heard, which is what a fast player reports as the sound lagging
// the finger. 0 asks for the smallest buffer the device allows — 11 ms on the
// same machine (2.7 ms base + the device). The cost is headroom: on a slow
// machine a tiny buffer can crackle under load. If it does, 0.003 measured
// 26 ms and 'interactive' puts it back.
export const AUDIO_LATENCY_HINT = 0;

export const SCRIPTS = {
  en: ['Sa', 'Ri', 'Ga', 'Ma', 'Pa', 'Da', 'Ni', 'Sá'],
  kn: ['ಸ', 'ರಿ', 'ಗ', 'ಮ', 'ಪ', 'ದ', 'ನಿ', 'ಸ̇'],
  hi: ['स', 'रि', 'ग', 'म', 'प', 'ध', 'नि', 'सं'],
  te: ['స', 'రి', 'గ', 'మ', 'ప', 'ద', 'ని', 'సం'],
  ta: ['ஸ', 'ரி', 'க', 'ம', 'ப', 'த', 'நி', 'ஸ்'],
};

// One letter per LADDER POSITION, taken from the English svara names so there
// is no second list to keep in step — S R R G G M M P D D N N across a
// chromatic octave, as Files/OCTAVES NOTES PLACMENT.svg labels its chart. Only
// the section roll's lanes read it now: a lane IS a ladder position, shared by
// the pair. The names on the staff and in the pitch chart moved to TONE_LETTER
// (see svaraName() in notation.js) so they match the piano key caps.
export const SVARA_LETTER = SCRIPTS.en.map(n => n[0].toUpperCase());

export const LANGS = {
  en: 'English', kn: 'ಕನ್ನಡ', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்',
};

export const FONTS = {
  en: '"Hanken Grotesk"',
  kn: '"Noto Sans Kannada"',
  hi: '"Noto Sans Devanagari"',
  te: '"Noto Sans Telugu"',
  ta: '"Noto Sans Tamil"',
};

// One clean letter per semitone, and the row of names printed across the top of
// the sheet: S r R g G m M P d D n N. Uppercase is the natural, lowercase the
// chromatic variant — with MADHYAMA THE EXCEPTION, because its variant is the
// sharp one: shuddha madhyama (5) is written `m` and prati madhyama (6) `M`.
// That is the convention on the printed sheet (see Files/DNG NOTATION PAGE
// LAYOUT.svg) and it is what Ma's other exceptions already say — the sharp
// variant, and the triangle notehead.
//
// Used by the sheet's tone legend, the note inspector and the piano key caps,
// so all three name a tone the same way.
export const TONE_LETTER = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];

// The notehead drawn under each letter in that legend is DERIVED from the same
// rule the staff draws by (see TONE_MARK, below MA_INDEX) rather than typed out
// twice, so the legend cannot drift from the notes.

// ---- Piano key span -------------------------------------------------------
// The staff writes three sthayis and no more, so the on-screen piano's whole
// range is 36 semitones — mandra Sa to taara Ni. PIANO_SPANS are the widths
// the dock's picker offers; the selected sthayi is centred in whichever is
// chosen and the neighbouring sthayis fill the rest, which is how a mandra or
// taara note gets played without switching tabs.
export const PIANO_RANGE = 36;
export const PIANO_SPANS = [12, 17, 24, 29, 36];

export const SOUND = {
  bindu: { dur: 1, deco: 'none' },
  vasu: { dur: 1 / 2, deco: 'bar1' },
  praya: { dur: 1 / 4, deco: 'bar2' },
  danta: { dur: 1 / 8, deco: 'bar3' },
  guru: { dur: 2, deco: 'curl' },
  Maguru: { dur: 4, deco: 'ring' },
};

// ---------- Chukki (the dot) ----------
//
// A chukki written next to a symbol adds HALF its value — and half of any
// symbol is exactly the next symbol down the hierarchy, so a dotted guru reads
// literally as "guru and bindu" and lasts 3 beats. The same rule holds all the
// way down:
//
//   Maguru •  4 + 2   = 6      vasu  •  1/2 + 1/4 = 3/4
//   guru   •  2 + 1   = 3      praya •  1/4 + 1/8 = 3/8
//   bindu  •  1 + 1/2 = 3/2
//
// Danta is the floor of the hierarchy with nothing below it, so it takes no
// chukki — DOTTABLE is every symbol that has a smaller neighbour.
export const DOT_MULT = 1.5;
export const DOTTABLE = ['Maguru', 'guru', 'bindu', 'vasu', 'praya'];

// A held note is written as the largest value it has actually reached, so
// holding through 3 beats writes guru + chukki rather than rounding down to a
// plain guru or jumping on to Maguru.
//
// Holding is resolved to ONE DANTA — an eighth of a beat, the smallest value in
// the hierarchy. Resolving any finer would only produce durations that cannot
// be written down; resolving any coarser (a whole beat, as it used to) makes
// the sub-beat symbols and the small chukkis unreachable by holding at all.
// The clock is its own, independent of the metronome, because a metronome tick
// cannot subdivide a beat. What that clock MEASURES against, though, is the
// metronome whenever one is running — see entryBeatMs() in score.js.
export const HOLD_TICK_UNITS = 1;

// What one beat is worth when ENTERING music with no metronome running.
//
// Not the tempo. With nothing counting, the tempo field is a number on a
// toolbar: it asks the player to hold some fraction of a second with nothing
// in the room to hold it against. The value that lands is then a surprise,
// which is the opposite of what holding a key is for. A SECOND is something
// anybody can hold and can check, so that is the beat when there is no beat —
// 1s a bindu, 2s a guru, 4s a Maguru. Switch the metronome on and the count is
// audible, and the clicks take over entirely.
//
// It is also why the default tempo (BPM) is 60: one beat a second, so Play
// gives back exactly what was pressed. At 72 it came back 20% fast.
export const ENTRY_BEAT_MS = 1000;

// Backstop only, for a key whose release never arrives (a missed MIDI
// note-off). A real hold of any length is written as held — the layout splits a
// long note across box lines with a join. Same ceiling as setNoteDuration().
export const HOLD_CAP_BEATS = 64;

// The smallest DNG weight is Danta (1/8 beat), so every beat is divided into
// eight timing units. Keeping weights as integers avoids float drift when
// packing boxes. As clock weight (a symbol's span in units) that is
// Danta 1, Praya 2, Vasu 4, Bindu 8, Guru 16, Maguru 32. The hierarchy runs
// the other way — how many of a symbol fill one Maguru: Maguru 1, Guru 2,
// Bindu 4, Vasu 8, Praya 16, Danta 32 — same ratios, counted from the top
// instead of the bottom.
export const TIME_UNITS_PER_BEAT = 8;

// Maximum weight one box holds. A different time signature changes this
// number; packing and rest-fill read it rather than assuming 4.
export const BOX_CAPACITY = 4;

// The MOST divisions a row will ever hold. A row is a GRID of equal divisions,
// so a division line falls at the same places on every row down the page and
// the third division of one row sits under the third of the row above — but
// how many of them there are is no longer a constant, because a division is
// not a constant either. It holds one CYCLE of the selected metre, and four
// eight-beat ADI cycles is thirty-two beats of music in the same 18 cm that
// carries sixteen under CHATUSRA: the same staff asked to say twice as much,
// so every glyph on it is half as wide. boxesPerRow() in timesig.js is what
// answers the count now, and this is only its ceiling — reached by every metre
// of four beats or fewer, which is why an ordinary sheet looks exactly as it
// did.
//
// It is also the number the last row is padded out to with empty divisions, so
// a fresh score opens with somewhere to type rather than a blank staff — that
// padding follows the same count, or a metre drawing two divisions to a row
// would open with four.
export const BOXES_PER_ROW = 4;

// The least staff a single BEAT is ever given, and the whole of the rule that
// sets a row's division count. A quarter of the staff under CHATUSRA gives a
// beat 56.5 units (1.08 cm); this is the floor under that, so four beats to a
// division still fits four divisions to a row and nothing about the ordinary
// sheet moves, while a longer cycle takes fewer divisions rather than shrinking
// its beats. The count is FLOORED against it (see boxesPerRow) — a row that
// ends up holding less than the staff is stretched back out by the justifier,
// and the alternative, rounding up, is exactly the crowding this exists to
// stop.
export const MIN_BEAT_W_CM = 0.9;

// Horizontal room given to every symbol, whatever its duration — the RELATIVE
// share it takes of the division it is in, not a final width. A division is a
// fixed quarter of the staff (BOXES_PER_ROW), and its symbols are scaled to
// fill it, so what this number sets is how the room inside a division is
// divided up: four bindus take a quarter of it each, and a Maguru beside two
// bindus takes half of it (44 against 22 and 22).
export const GLYPH_W = 22;

// Breathing room inside a division, at each end, before the first cell starts
// and after the last one finishes. Glyphs are drawn CENTRED in their cells, so
// without it the ink of an edge glyph sits about 3 units off the division line
// in a densely packed box — a bar is 15.75 wide in a 22-unit cell — and the
// notation reads as if it were hanging on the line rather than written inside
// it. The cells are scaled into what is left, so this is an inset and not
// extra width: an ordinary division is still exactly a quarter of the staff.
// A dense division, which already takes the room it needs, grows by 2 × this.
export const BOX_PAD = 7;

// Air on EACH SIDE of every symbol, not just at the two ends of a division —
// the space between one glyph's ink and the next one's.
//
// GLYPH_W above is only a SHARE: a division is scaled to fill its quarter, so
// making every share bigger changes nothing about how far apart the glyphs
// end up. The one thing a share does fix absolutely is the floor — when a
// division holds more than its quarter can carry it takes its symbols' own
// room, and every cell is then exactly its share. At that floor a danta's
// 15.75-unit bar sat in a 22-unit cell, which is 3.1 units of air per side:
// half a millimetre, so a packed run read as one comb of ink rather than as
// separate notes.
//
// This is the absolute part of a cell, added to the scaled share rather than
// mixed into it, so the room a symbol asks for and the air beside it stay two
// different things: the shares still hold their ratio to each other (a Maguru
// cell against a bindu's) while the air is the same beside every symbol,
// whatever it is worth — it is about ink clearance, not duration.
//
// It is paid for the way BOX_PAD is: out of the division, never on top of it.
// What it costs is how much a quarter carries before it starts claiming room
// of its own — about seven barred symbols now rather than nine — so a dense
// bar takes a wider division and its row holds three instead of four. That is
// the trade the grid was always willing to make (see BOXES_PER_ROW); this
// moves the point at which it is made, from "the bars would touch" to "the
// notes can be told apart".
export const GLYPH_GAP = 2.5;

// Per-symbol overrides. Maguru (ring) and Guru (curl) carry more ink than the
// plain heads, so they get wider cells; everything else uses GLYPH_W.
export const GLYPH_W_OF = { Maguru: 44, guru: 34 };

// Tala definitions — the METRE, and the only thing that says how big a
// division is. `groups` is the additive formula spelled out: a division holds
// their sum in beats, and each interior group edge draws a lighter divider
// inside the division and accents the metronome. BOX_CAPACITY above is only
// the fallback for when no tala resolves.
//
// CHATUSRA is the plain 4 the staff has always drawn, and is what a new
// document opens on. The four Carnatic talas are their true lengths — ADI is
// eight beats with a group edge at the fifth, not two separate divisions —
// so selecting one now changes the staff instead of only naming it.
//
// Custom entries live beside these at runtime; timesig.js owns that registry,
// its localStorage copy and the definition embedded in a saved score. These
// four cannot be edited or deleted: saved files name them by key.
export const TALAS = {
  chatusra: { label: 'CHATUSRA',     formula: '4',    beats: 4, groups: [4] },
  adi:      { label: 'ADI TALA',     formula: '4+4',  beats: 8, groups: [4, 4] },
  rupaka:   { label: 'RUPAKA TALA',  formula: '4+2',  beats: 6, groups: [4, 2] },
  khanda:   { label: 'KHANDA CHAPU', formula: '4+1',  beats: 5, groups: [4, 1] },
  misra:    { label: 'MISRA CHAPU',  formula: '4+3',  beats: 7, groups: [4, 3] },
};

// Sanity bounds for a custom metre. A division wider than the staff is not
// refused — the row justifier scales it down to fit (see usableWidth()) — but
// nothing musical needs more than this, and an unbounded number would let a
// typo pack thousands of beats into one box.
export const MAX_TS_BEATS = 64;
export const MAX_TS_GROUPS = 16;

// Interior group edges are drawn at staff weight but faded, so a group reads
// as subordinate to the division it sits inside. Note ink (1.575u) would be
// HEAVIER than the division line (1u), which says the opposite.
export const GROUP_LINE_OPACITY = 0.45;

// A preset entry is either
//   a bare svara index         — the varase form: one sthayi, one bindu each
//   [svi, oct, sym, dot, head] — a tune that needs its own octaves and
//                                durations. Everything after `svi` is optional
//                                and defaults to oct 0, bindu, no chukki, and a
//                                hollow (natural) goli.
export const PRESETS = {
  sarale: [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0],
  janti: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
  dhatu: [0, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 4, 2, 0],
  mandra: [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0],
  tara: [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0],

  // Sa = C, so these are all naturals. Written as [svi, oct, sym] tuples.

  // 24 beats in four 6-beat phrases.
  happy: [
    [4, 0, 'vasu'], [4, 0, 'vasu'], [5, 0], [4, 0], [0, 1], [6, 0, 'guru'],
    [4, 0, 'vasu'], [4, 0, 'vasu'], [5, 0], [4, 0], [1, 1], [0, 1, 'guru'],
    [4, 0, 'vasu'], [4, 0, 'vasu'], [4, 1], [2, 1], [0, 1], [6, 0], [5, 0],
    [3, 1, 'vasu'], [3, 1, 'vasu'], [2, 1], [0, 1], [1, 1], [0, 1, 'guru'],
  ],

  // Sa Sa Pa Pa Da Da Pa- / Ma Ma Ga Ga Ri Ri Sa- ... 48 beats.
  twinkle: [
    [0, 0], [0, 0], [4, 0], [4, 0], [5, 0], [5, 0], [4, 0, 'guru'],
    [3, 0], [3, 0], [2, 0], [2, 0], [1, 0], [1, 0], [0, 0, 'guru'],
    [4, 0], [4, 0], [3, 0], [3, 0], [2, 0], [2, 0], [1, 0, 'guru'],
    [4, 0], [4, 0], [3, 0], [3, 0], [2, 0], [2, 0], [1, 0, 'guru'],
    [0, 0], [0, 0], [4, 0], [4, 0], [5, 0], [5, 0], [4, 0, 'guru'],
    [3, 0], [3, 0], [2, 0], [2, 0], [1, 0], [1, 0], [0, 0, 'guru'],
  ],

  // Ga Ri Sa Ri / Ga Ga Ga- ... 32 beats.
  mary: [
    [2, 0], [1, 0], [0, 0], [1, 0],
    [2, 0], [2, 0], [2, 0, 'guru'],
    [1, 0], [1, 0], [1, 0, 'guru'],
    [2, 0], [4, 0], [4, 0, 'guru'],
    [2, 0], [1, 0], [0, 0], [1, 0],
    [2, 0], [2, 0], [2, 0], [2, 0],
    [1, 0], [1, 0], [2, 0], [1, 0],
    [0, 0, 'Maguru'],
  ],

  // Beethoven. The 1.5-beat notes are a bindu carrying a chukki. 32 beats.
  ode: [
    [2, 0], [2, 0], [3, 0], [4, 0],
    [4, 0], [3, 0], [2, 0], [1, 0],
    [0, 0], [0, 0], [1, 0], [2, 0],
    [2, 0, 'bindu', true], [1, 0, 'vasu'], [1, 0, 'guru'],
    [2, 0], [2, 0], [3, 0], [4, 0],
    [4, 0], [3, 0], [2, 0], [1, 0],
    [0, 0], [0, 0], [1, 0], [2, 0],
    [1, 0, 'bindu', true], [0, 0, 'vasu'], [0, 0, 'guru'],
  ],
};

// Tempo a preset wants, where its default differs from BPM. Happy Birthday
// drags badly at 72.
export const PRESET_BPM = { happy: 96, twinkle: 108, mary: 108, ode: 112 };

export const TITLES = {
  sarale: 'SARALE VARASE',
  janti: 'JANTI VARASE',
  dhatu: 'DHATU VARASE',
  mandra: 'MANDRASTHAYI VARASE',
  tara: 'TAARASTHAYI VARASE',
  happy: 'HAPPY BIRTHDAY',
  twinkle: 'TWINKLE TWINKLE LITTLE STAR',
  mary: 'MARY HAD A LITTLE LAMB',
  ode: 'ODE TO JOY',
};

// ---------- Symbol file paths ----------

// SVG symbol files. Each sound has 5 variants:
//   white / black    — regular notehead (goli hollow / filled)
//   ledgeWhite / ledgeBlack — notehead with a ledger line through it, used
//                             when the pitch sits on an imaginary staff line
//                             above TOPY or below BOTY
//   rest             — rest symbol
export const SYM_FILE = {
  bindu:  { white: './symbols/bindu_white.svg',  black: './symbols/bindu_black.svg',  rest: './symbols/bindu_rest.svg',
            ledgeWhite: './symbols/bindu_ledge_white.svg',  ledgeBlack: './symbols/bindu_ledge_black.svg' },
  vasu:   { white: './symbols/vasu_white.svg',   black: './symbols/vasu_black.svg',   rest: './symbols/vasu_rest.svg',
            ledgeWhite: './symbols/vasu_ledge_white.svg',   ledgeBlack: './symbols/vasu_ledge_black.svg' },
  praya:  { white: './symbols/praya_white.svg',  black: './symbols/praya_black.svg',  rest: './symbols/praya_rest.svg',
            ledgeWhite: './symbols/praya_ledge_white.svg',  ledgeBlack: './symbols/praya_ledge_black.svg' },
  danta:  { white: './symbols/danta_white.svg',  black: './symbols/danta_black.svg',  rest: './symbols/danta_rest.svg',
            ledgeWhite: './symbols/danta_ledge_white.svg',  ledgeBlack: './symbols/danta_ledge_black.svg' },
  guru:   { white: './symbols/guru_white.svg',   black: './symbols/guru_black.svg',   rest: './symbols/guru_rest.svg',
            ledgeWhite: './symbols/guru_ledge_white.svg',   ledgeBlack: './symbols/guru_ledge_black.svg' },
  Maguru: { white: './symbols/Maguru_white.svg', black: './symbols/Maguru_black.svg', rest: './symbols/Maguru_rest.svg',
            ledgeWhite: './symbols/Maguru_ledge_white.svg', ledgeBlack: './symbols/Maguru_ledge_black.svg' },
};

// Transport-control glyphs from DNG assets.
export const TRANSPORT_FILE = {
  daro: './symbols/Daro.svg',   // go to beginning
  enjo: './symbols/Enjo.svg',   // stop
};

export const REST_MAP = {
  rest_symbol_1: 'bindu',
  rest_2: 'vasu',
  rest_3: 'praya',
  rest4: 'danta',
  rest_5: 'guru',
  rest_6: 'Maguru',
};

// symbols/repeat_*.svg is REFERENCE ARTWORK now — nothing loads it. The mark
// is drawn by repeatMark() in notation.js off the repeat block further down
// this file, which is where its geometry was measured off those three files.

// ---------- Layout constants for the sheet SVG ----------
//
// The staff has a fixed PHYSICAL size, not just a ratio: 18.00 cm from the
// left edge of the staff box to the closing barline, and 0.8 cm from the top
// line to the bottom line. Everything below is derived from those two numbers
// so the sheet prints, exports and displays at true size.
//
//   staff height = BOTY - TOPY = 3 * STEP = 42 units  ==  STAFF_H_CM
//   => UNITS_PER_CM = 42 / 0.8 = 52.5
//   => 18 cm of staff = 945 units
//
// 18 cm is A4 (21 cm) less a 1.5 cm margin on each side.
export const STAFF_W_CM = 18;
export const STAFF_H_CM = 0.8;
export const UNITS_PER_CM = 52.5;
export const UNITS_PER_MM = UNITS_PER_CM / 10;

// Staff span in units — BX0 to (VW - RPAD). Exactly STAFF_W_CM wide.
export const STAFF_W = STAFF_W_CM * UNITS_PER_CM;   // 945

// BX0 / RPAD are bleed outside the staff lines, so ledger lines and the
// closing barline stroke are not clipped. They sit outside the 18 cm, and are
// kept EQUAL so that centring the row also centres the staff on the page.
export const BLEED = 16;
export const LPAD = 56;
export const RPAD = BLEED;
export const BX0 = BLEED;
export const VW = BX0 + STAFF_W + RPAD;             // 977

// Room a row has for divisions: the staff less the gutter the sthayi key and
// the row number sit in. notation.js's usableWidth() returns this; it is here
// because timesig.js has to answer how many divisions fit in it without
// importing the renderer to ask.
export const USABLE_W = VW - LPAD - RPAD;           // 905

// MIN_BEAT_W_CM in staff units — 47.25.
export const MIN_BEAT_W = MIN_BEAT_W_CM * UNITS_PER_CM;

// Four visible horizontal lines, equally spaced by STEP. Svaras are placed
// at half-STEP intervals — so they alternate line-space-line-space as they
// climb. One rung per octave carries no notation (see SVARA_RUNG).
export const STEP = 14;
export const MAGY = 86;
export const BOTY = MAGY + STEP;          // 100  · bottom line
export const GTOP = MAGY - STEP;          //  72  · white/green divider
export const TOPY = MAGY - 2 * STEP;      //  58  · top of staff
// The vertical range a row covers for free. These are NOT clamps on pitch —
// the ladder runs as far out as the music goes (see below) — they are just how
// much room the row box gives before rowExtent() has to grow it. The numbers
// are the old 15-slot range, y=30 (taara Ma) to y=135 (mandra Ma), which is
// still about what a normal score uses.
export const LINE_TOP = MAGY - 8 * (STEP / 2);  // 30
export const LINE_BOT = MAGY + 7 * (STEP / 2);  // 135

// ---------- The magic line's two echoes ----------
//
// The magic line carries no notation, and that empty rung repeats one octave
// out on each side: 4 STEPs above MAGY in taara, 4 STEPs below it in mandra.
// The drawings mark both with a full-width dot-dash rule spanning the staff, so
// a reader can see the octave boundary without counting ledgers.
//
// Measured off Files/OCTAVES NOTES PLACMENT.svg: every row there carries a pair
// of these (class .str2), the upper at 28.5 drawing-STEPs above the staff box
// top and the lower at 83.6 below, which is y=30 and y=142 here. Width 20
// drawing units and dash pattern 20/100/20/200 convert at 19.0571 units per
// staff unit.
export const OCTAVE_RULE_Y = [MAGY - 4 * STEP, MAGY + 4 * STEP];  // 30 · 142
// Drawn heavier and denser than the drawing's .str2 dash-dot, which at row
// scale resolves to a handful of stray specks. This is the .str5 rhythm — an
// even run of dots — tightened further so the rule reads as a continuous line
// of dots rather than punctuation.
export const OCTAVE_RULE_W = 1.4;
export const OCTAVE_RULE_DASH = '1.4 2.8';

// MINIMUM vertical extent of a rendered row. A row whose notes all fall inside
// LINE_TOP..LINE_BOT is exactly this tall; a row reaching further out grows
// past it. rowSVG() measures its own content and only ever grows beyond these
// bounds, never shrinks.
export const ROW_TOP = LINE_TOP - 30;           //   0
export const ROW_BOT = LINE_BOT + 16;           // 151
export const ROW_H = ROW_BOT - ROW_TOP;         // 151

// ---------- Mandra / Taara: one ladder, continued past the staff ----------
//
// All three sthayis are placed by the SAME rule. There is one ladder: every
// svara sits a half-STEP (7 units) above the one below it, and it simply keeps
// going past the top and bottom lines instead of stopping there. Mandra and
// taara are not a special case — they are madhya's ladder continued, and how
// far out you are is read off the LEDGER COUNT, exactly as on a Western staff.
//
// SVARA_RUNG is the whole pitch rule. Reading S R G M P D N it climbs one rung
// at a time EXCEPT between Ga and Ma, which is a double step: the rung in
// between carries no notation. Inside the staff that empty rung is the magic
// line; outside it, it is a ledger line the notes step over. Either way it
// costs a rung, so an octave is 8 rungs — 4 whole STEPs, one full staff — and
// EVERY sthayi is drawn to the same pattern rather than madhya alone.
// (Measured off `Files/OCTAVES NOTES PLACMENT.svg`: 3 octaves span exactly 24
// half-steps, with the double step landing at G->M in all three.)
//
// Ledgers continue the staff's own line spacing (STEP, 14 units) outward, so
// the alternation of line and space carries on unbroken:
//
//        taara  Sa 51·space   Ri 44·line1  Ga 37·space  [30·line2 empty]
//                Ma 23·space  Pa 16·line3  Da  9·space   Ni  2·line4
//      madhya  Sa 107  Ri 100·BOTY  Ga 93  [86·MAGY empty]
//                Ma 79  Pa 72·GTOP  Da 65  Ni 58·TOPY
//       mandra  Ni 114·line1  Da 121·space  Pa 128·line2  Ma 135·space
//                [142·line3 empty]  Ga 149·space  Ri 156·line4  Sa 163·space
//
// The ladder has no seam at a sthayi boundary: Sá (svaraIndex 7) of one sthayi
// is Sa of the next and lands on the same position — madhya Sá and taara Sa are
// both y=51, mandra Sá and madhya Sa are both y=107.
//
// Stems are one fixed length everywhere and flip at the magic line, which is
// what keeps them pointing back toward the staff on both outer sthayis. Nothing
// about the glyph changes with octave; only its height on the ladder does.
export const SVARA_RUNG = [0, 1, 2, 4, 5, 6, 7, 8];   // S R G M P D N Sá
export const RUNGS_PER_OCTAVE = 8;
//
// Unit -> physical helpers. Use these anywhere a real-world size is needed
// (CSS sizing of the row SVG, PDF placement, SVG export) so the 18 x 0.8 cm
// rule stays in one place.
export const toCM = u => u / UNITS_PER_CM;
export const toMM = u => u / UNITS_PER_MM;

// ---------- The printed page ----------
//
// The on-screen sheet IS the page. `.sheet` in index.html is 21 cm wide with
// 1.1952 cm of side padding, which is exactly the row SVG's width, so the 18 cm
// staff inside it lands 1.5 cm from each paper edge; `@page { margin: 0 }` then
// prints it at true size.
//
// exportPDF() cannot use the DOM — it rebuilds that same layout out of jsPDF
// primitives — so every measurement the two share lives HERE rather than being
// typed once into the stylesheet and once into pdf.js. That is the whole reason
// this block exists: the export and the page it is exporting have to agree, and
// two copies of a number do not stay equal. The stylesheet is written in CSS
// pixels, so the conversion (96 dpi, 1px = 25.4/96 mm) is done once, here, and
// the comment beside each value names the rule it comes from.
export const PX_MM = 25.4 / 96;
export const px = n => n * PX_MM;

export const PAGE_W_MM = 210;
export const PAGE_H_MM = 297;
export const SHEET_PAD_X = 11.952;              // .sheet padding — 1.1952cm
export const SHEET_PAD_TOP = px(22);            // .sheet padding-top
export const SHEET_PAD_BOT = px(34);            // .sheet padding-bottom
export const SHEET_W_MM = PAGE_W_MM - 2 * SHEET_PAD_X;   // 186.10 — one row wide

// .sheet-head — emblem, a rule, the tone legend, all on one axis.
export const EMBLEM_MM = px(44);                // .emblem width/height
export const HEAD_RULE_W = px(1.4);             // .headrule border-top
export const HEAD_GAP_BOT = px(10);             // .sheet-head margin-bottom

// table.tones — the twelve-tone legend at the head's right.
export const TONE_CELL_W = px(28);              // td width
export const TONE_ROW_H = px(22);               // td height (letters)
export const TONE_MK_H = px(23);                // .mk height (noteheads)
export const TONE_BORDER = px(1.4);             // td border
export const TONE_PT = 15 * 0.75;               // td font-size 15px
export const TONE_BG = '#fdf5c4';
export const TONE_LINE = '#3a3a36';
export const MK_O_R = px(11.5 / 2);             // .mk-o — 10px box + 1.5px border
export const MK_O_W = px(1.5);
export const MK_F_R = px(10 / 2);               // .mk-f
export const MK_T_W = px(12);                   // .mk-t viewBox is 1:1 with px
export const MK_T_H = px(11);

// .sheet-meta — Title / K.S. over Tempo / T.S.
export const META_TOP = px(34);                 // margin-top
export const META_GAP = px(18);                 // row-gap
export const META_BOT = px(26);                 // margin-bottom
export const META_LINE = px(18);                // one .metaline, as laid out
export const META_PT = 15 * 0.75;               // .metaline font-size
export const META_VAL_GAP = px(8);              // .metaline .val margin-left

// .score-rows
export const SCORE_PAD_Y = px(4);               // padding
export const ROW_GAP_MM = px(18);               // gap between rows

// .sheet .pagenum — the yellow pill at the foot, and © Lyptron beside it.
export const PILL_BOTTOM = px(14);
export const PILL_W_MM = px(34 + 24 + 2.8);     // min-width + padding + border
export const PILL_H_MM = px(15 + 6 + 2.8);      // line + padding + border
export const PILL_R_MM = px(11);
export const PILL_PT = 13 * 0.75;
export const BRAND_RIGHT = px(14);
export const BRAND_BOTTOM = px(8);
export const BRAND_PT = 11 * 0.75;
export const BRAND_COLOR = '#7a4b9c';
export const SHEET_INK = '#111';

// Where rows start and stop on a page. Page one starts under the head; a later
// page carries no head — the sheet does not repeat one — so its rows start at
// the sheet's own top padding. Rows stop where the page pill starts, not at an
// invented margin. PAGE_GAP is screen only: the stage showing between two
// pages in Page view.
//
// These are MEASURED against the live sheet (first row at 186px), not only
// summed from the rules: the head's margin-bottom and the meta block's
// margin-top COLLAPSE, so the gap between them is the larger of the two and
// not their sum, and the legend table is its two rows plus one whole pixel of
// collapsed border.
export const HEAD_H = Math.max(EMBLEM_MM, TONE_ROW_H + TONE_MK_H + px(1));
export const META_Y = SHEET_PAD_TOP + HEAD_H + Math.max(HEAD_GAP_BOT, META_TOP);
export const PAGE_FIRST_Y = META_Y + META_LINE * 2 + META_GAP + META_BOT + SCORE_PAD_Y;
export const PAGE_NEXT_Y = SHEET_PAD_TOP + SCORE_PAD_Y;
export const PAGE_BOT_LIMIT = PAGE_H_MM - Math.max(SHEET_PAD_BOT, PILL_BOTTOM + PILL_H_MM + 2);
export const PAGE_GAP_MM = px(24);

// jsPDF takes colour channels, the stylesheet writes hex — and writes SHORTHAND
// where it can, so the three-digit form has to be EXPANDED, not sliced. Slicing
// '#111' as if it were six digits yields a NaN blue channel, and jsPDF answers
// that with "Invalid argument passed to jsPDF.f2" from somewhere several calls
// away. It lives here, beside the colours it converts, so there is one place to
// get it right.
export const rgb = (h) => {
  const s = String(h).replace('#', '');
  const full = s.length === 3 ? s.replace(/./g, c => c + c) : s;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

// ---------- The row gutter ----------
//
// The row number and the sthayi key, in the page's left margin. In STAFF UNITS
// and measured from the row SVG's own left edge (negative = further left), so
// the screen's CSS and the PDF's jsPDF calls place them from one set of numbers
// — they used to carry separate copies and had drifted apart by 2 mm.
//
// Sizes are measured off the drawing against the 0.8 cm staff height.
export const GUTTER_NUM_X = -36.75;   // number's centre · 0.70cm left of the SVG
export const GUTTER_MARK_X = -9.45;   // key's centre    · 0.18cm left of the SVG
export const GUTTER_NUM_BOX = 26.25;  // 0.5cm — the box the number is centred in
export const GUTTER_NUM_SIZE = 18.9;  // 0.36cm — .srow .num b font-size
export const GUTTER_SQ = 13.5;        // madhya square
export const GUTTER_TRI_W = 14.5;     // taara/mandra triangle
export const GUTTER_TRI_H = 12.5;

// How far past the outer staff lines the two triangles sit, to their CENTRE,
// and how far the madhya square is nudged along the staff from the magic line
// (negative = toward taara, since y grows downward).
export const GUTTER_OUT = 4;
export const GUTTER_MID_OFFSET = -4;

// ---------- Note glyph geometry ----------

// Notes are drawn in code rather than dropped in as images, so the goli stays
// the same size on every symbol and the stem is one fixed length.
//
// TWO PHYSICAL RULES, same anchor as the 18 x 0.8cm staff:
//   · stem length 0.54 cm, measured from the EDGE of the goli to the stem tip
//   · 0.3 mm of ink on the stem, the curl, the ring and the goli outline
// Both are converted to staff units here so nothing downstream re-derives them.
export const STEM_LEN_CM = 0.54;
// 0.42, not the drawing's 0.3: at screen and print scale a 0.3mm hairline
// antialiases to a grey smear and the notation reads faint against the green.
// This is a deliberate departure from the measured spec — everything else on
// the glyph (stem length, goli size, ornament offsets) is still the drawing's.
export const NOTE_INK_MM = 0.42;
export const STEM_LEN = STEM_LEN_CM * UNITS_PER_CM;   // 28.35 staff units
export const NOTE_INK_W = NOTE_INK_MM * UNITS_PER_MM; //  1.575 staff units

// ---- the joining arc ----
//
// A join is drawn OUTSIDE the head it belongs to, on the side away from the
// stem, and it needs room to be read as an arc rather than as a line through
// the notation. It had none: the arc sat 6 units from the head's centre and a
// goli's radius is 6.03, so both of its ends started INSIDE the notehead
// outline — 0.03 units the wrong side of it — and the bow, 5 units at the
// control point, peaks at half that, 2.5 units or half a millimetre. Reported
// from the field as the join needing "some vertical space", which is exactly
// what it did not have.
//
// JOIN_GAP is that space: clear air between the edge of the goli and the arc's
// ends, so the arc is measured from the head it hangs off rather than from an
// assumption about how big that head is.
export const JOIN_GAP = 4;

// How deep the arc bows, as a fraction of the span it crosses — a long join
// carries a bigger curve, the way one drawn by hand does — clamped so a join
// between two crowded glyphs is still visibly an arc and one across half a
// staff does not turn into a balloon. Note the drawn curve peaks at HALF the
// control point's offset, this being a quadratic, so the visible depth is half
// of what these say.
export const JOIN_BOW = 0.12;
export const JOIN_BOW_MIN = 8;
export const JOIN_BOW_MAX = 18;

// Thinner than the notation it joins — a join is not a symbol — but not the
// 1-unit hairline it was, which is 0.19 mm and antialiases to grey at row
// scale for the same reason NOTE_INK_MM is a departure from the drawing.
export const JOIN_INK_W = NOTE_INK_W * 0.7;

// The shapes themselves are still lifted from the artwork in symbols/ (which
// rests continue to use) and are in that artwork's own units. NOTE_SCALE
// converts them to staff units.
// The head and the bars are MEASURED off Files/OCTAVES NOTES PLACMENT.svg,
// where 1 staff unit is 19.048 drawing units: the goli is r=114.72 there
// (6.02 staff units, a 2.29mm head), a duration bar spans 300 (15.75 units)
// and is stroked 40 wide (2.10 units). Divided by NOTE_SCALE those are the
// artwork numbers below, so the printed note is the size the drawing draws.
export const NOTE_SCALE = 1.25;
export const GOLI_R = 4.82;       // goli radius        · 6.02u · 2.29mm
export const BAR_W = 12.60;       // width of a duration bar   · 15.75u
export const BAR_H = 1.68;        // thickness of a duration bar · 2.10u

// Every symbol now shares one stem length, so what distinguishes them is only
// what they carry on top of it. Offsets are measured DOWN from the stem tip,
// in artwork units — that way an ornament stays welded to the tip and cannot
// drift halfway down the stem when the stem length changes.
//
// Guru's curl and Maguru's ring are both sized to the GOLI: each is exactly
// one goli-diameter tall and caps the stem, so the glyph reads as head-and-
// echo rather than a big ornament on a small note. Expressed in terms of
// GOLI_R rather than as literals, so resizing the notehead resizes them with
// it and the proportion cannot drift.
export const NOTE_GEOM = {
  bindu:  { bars: [] },
  vasu:   { bars: [0] },
  praya:  { bars: [0.5, 4.2] },
  danta:  { bars: [0.5, 4.2, 7.9] },
  guru:   { bars: [], curl: { from: 2 * GOLI_R, to: 0, r: GOLI_R } },
  Maguru: { bars: [], ring: { cy: GOLI_R, r: GOLI_R } },
};

// ---------- M2 (prati madhyama) ----------
//
// Of the five chromatic variants, four are FLAT — r, g, d, n all sit a semitone
// below their natural. M2 is the exception: it is a semitone ABOVE Ma. A filled
// goli reads as "the lowered one", so it cannot carry M2 without saying the
// wrong thing. M2 therefore keeps a HOLLOW goli and is marked with a triangle.
//
// M2 does not carry an extra mark — its NOTEHEAD IS a triangle, drawn in place
// of the goli at the same pitch position. Point-up, hollow, same 0.3mm ink.
//
// MA_INDEX is the ladder position the rule applies to. The triangle is sized
// off GOLI_R so it scales with the notehead, and is a little wider and taller
// than the circle it replaces so the two read at the same visual weight — a
// triangle of equal width to a circle looks smaller than it is.
export const MA_INDEX = 3;
export const M2_TRI_W = GOLI_R * 2.4;    // artwork units, scaled by NOTE_SCALE
export const M2_TRI_H = GOLI_R * 2.1;

// The notehead each of the twelve tones is written with, in semitone order —
// the second row of the sheet's tone legend, under TONE_LETTER. It is read off
// the same two rules the staff draws by, so the printed key cannot disagree
// with the notes under it:
//
//   'o' hollow goli    the seven naturals
//   'f' filled goli    a LOWERED variant — r g d n
//   't' triangle       M2, the one variant that is raised (see above)
export const TONE_MARK = Array.from({ length: 12 }, (_, semi) => {
  if (SVARA_TONES.some(t => t.natural === semi)) return 'o';
  return semi === SVARA_TONES[MA_INDEX].variant ? 't' : 'f';
});

// Chukki geometry. The dot sits to the RIGHT of the goli and level with it,
// and is sized off GOLI_R so it scales with the notehead instead of drifting.
// DOT_ROOM is the extra horizontal cell a dotted glyph needs so the dot is not
// crowded by the next symbol.
export const DOT_R = GOLI_R * 0.42;      // artwork units, scaled by NOTE_SCALE
export const DOT_GAP = GOLI_R * 0.55;    // clear space from goli edge to dot
export const DOT_ROOM = 8;               // staff units of extra cell width

// ---------- Rests ----------
//
// The rests are DRAWN, like the notes, not stamped from the artwork in
// symbols/. Every number below is measured off the rest row — the second staff
// — of reference/DNG-STUDIO-REFERENCE.pdf, where the staff's 0.8 cm measures
// 22.68 pt, so 1 pt = 42/22.68 = 1.85185 staff units.
//
// What the drawing writes, in one line each:
//
//   Maguru  a ring with a dot in it
//   guru    a half-disc, flat side left, with a dot in it
//   bindu   a wedge pointing DOWN — a V
//   vasu    a wedge pointing UP, with one bar across it
//   praya   the same wedge with two bars
//   danta   the same wedge with three bars
//
// Every one of them is centred on GTOP and sits in the upper green band, so a
// rest reads at the same height whatever it is worth — only its width and what
// it carries change. That is why REST_MID is the one vertical anchor here.
export const REST_MID = GTOP;             // 72 · every rest centres on this

// The wedge: 10.638 pt tall and 4.209 pt across the wide end, drawn as two
// lines running from the apex out to the corners. REST_SPIKE_W is the span
// between the two LINE CENTRES, so the ink lands where the drawing's outline
// does.
export const REST_SPIKE_H = 19.70;        // 10.638 pt · 3.75 mm
export const REST_SPIKE_W = 6.55;         //  3.537 pt, centre to centre

// Bars across the wedge, measured DOWN FROM THE APEX in staff units — the same
// way a note's ornament hangs back from its stem tip, so the two hierarchies
// are written the same way. Only the up-pointing wedges carry them; bindu's
// wedge points down and carries none, which is what separates it from vasu.
// The bars are 8.504 pt wide, which is 15.75 u — the note's own BAR_W, so a
// rest bar and a note bar are the same mark.
export const REST_GEOM = {
  bindu:  { up: false, bars: [] },
  vasu:   { up: true,  bars: [10.71] },
  praya:  { up: true,  bars: [7.26, 10.71] },
  danta:  { up: true,  bars: [7.26, 10.71, 14.16] },
};
export const REST_BAR_W = BAR_W * NOTE_SCALE;   // 15.75 u, as the notes use

// Maguru's ring and guru's half-disc. The drawing strokes these at 1.5 pt and
// 1.417 pt — noticeably bolder than the 0.3 mm hairline it draws everything
// else with — and that weight is what makes the two long rests read as long
// rests, so it is kept as measured rather than folded into NOTE_INK_W. The
// wedge and the bars ARE hairlines, and they take NOTE_INK_W for the same
// reason the note glyphs do: at row scale 0.3 mm antialiases to grey.
export const REST_RING_R = 8.66;          // 4.6775 pt
export const REST_RING_INK = 2.78;        // 1.500 pt · 0.53 mm
export const REST_HALF_RX = 11.81;        // 6.378 pt — the bulge, flat side left
export const REST_HALF_RY = 8.58;         // 4.6305 pt
export const REST_HALF_INK = 2.62;        // 1.417 pt · 0.50 mm
export const REST_DOT_R = 2.22;           // 1.1985 pt · the dot inside both
export const REST_DOT_DX = 5.15;          // 2.783 pt right of the half-disc's flat edge

// How far the heaviest ornament reaches back from the stem tip, in staff
// units. The curl and the ring are the furthest — both stop at one goli-
// diameter, 12.05u — with danta's third bar (its outer edge, not its centre)
// just short of them at 10.93u. Nothing positions
// itself by this any more — it is kept because it is the number that says how
// much clearance a stem tip needs, which is worth knowing before changing
// STEM_LEN or NOTE_GEOM.
export const ORNAMENT_REACH = NOTE_SCALE * Math.max(
  ...Object.values(NOTE_GEOM).map(g => Math.max(
    g.bars && g.bars.length ? Math.max(...g.bars) + BAR_H / 2 : 0,
    g.curl ? g.curl.from : 0,
    g.ring ? g.ring.cy + g.ring.r : 0,
  )),
);                                                 // 12.05 units

// ---------- Where an out-of-staff stem ends ----------
//
// Mandra and taara golis sit out past the staff on the ladder, and their stems
// do NOT stop at the standard 0.54cm — they run all the way back IN to the
// staff and finish at one of these two anchors, in the spaces flanking the
// magic line. So the stem length varies with how far out the note is, while the
// stem TIP is always in the same place, which puts every ornament — bars, curl,
// ring — in one readable band whatever the sthayi.
//
// The anchors are the two lines flanking the UPPER green band, measured off
// Files/OCTAVES NOTES PLACMENT.svg: every mandra stem in the low-octave row ends
// at 72.7u and every taara stem in the high-octave row at 85.0u — GTOP and MAGY
// to within the drawing's own slop. Both ornament bands therefore live between
// GTOP and MAGY, on opposite sides of it, which is why a mandra praya and a
// taara praya read at the same height on the page.
//
// The ornament grows back from the tip toward the goli, so the deepest one
// (guru's curl, ORNAMENT_REACH away) reaches 84.05 going down from GTOP and 73.95
// going up from MAGY — both inside the green. Check that still holds if
// NOTE_GEOM grows: an ornament deeper than STEP would spill past the band.
export const STEM_ANCHOR_BELOW = GTOP;   // 72 · mandra stems rise to here
export const STEM_ANCHOR_ABOVE = MAGY;   // 86 · taara stems hang to here

// ---------- The repeat mark ----------
//
// DRAWN, like the notes and the rests — not fetched. It used to be an <image>
// pointing at symbols/repeat_*.svg, cropped to one half by a nested viewBox,
// and that cost three things at once: an external raster of a hairline at row
// scale antialiases to grey, so the brace read as a smudge beside ink-black
// notation; exportSVG() writes the row markup out on its own, so the relative
// href resolved against nothing and the marks vanished from every exported
// SVG; and pdf.js needed a preload-and-absolutize dance to get them into a
// page at all. The artwork stays in symbols/ — it is what these numbers were
// measured off — but nothing reads it any more.
//
// The mark is a bracket — a vertical with a flare splaying off each end into
// the music it encloses — plus a stack of dots saying how many times through.
// The count IS the dot count: two dots ×2, three ×3, four ×4.
//
// Measured off symbols/repeat_2.svg (40×38 artwork, the left half the opening
// brace and the right half the closing one) scaled so the flare tips land
// exactly on TOPY and BOTY — 42 staff units over the drawing's 36.76, so
// 1 artwork unit = 1.1425 staff units.
export const REPEAT_MID = (TOPY + BOTY) / 2;   // 79 · the mark is symmetric about this

// How far a flare reaches out from the vertical, and how far the vertical is
// held back from the staff lines the flares reach.
export const REPEAT_WING_X = 8.83;        // 7.73 artwork units
export const REPEAT_V_INSET = 7.75;       // vertical runs TOPY+this .. BOTY-this

// The dots. The artwork's are 1.13u across the radius, which is 0.43 mm of
// disc — invisible at row scale next to a 2.29 mm goli, and the first thing
// that went when the mark was rasterised. Opened up to 0.8 mm across — the
// size of the dot inside a Maguru rest, which is the smallest filled disc
// this notation prints and still reads.
export const REPEAT_DOT_R = 2.10;
export const REPEAT_DOT_DX = 5.71;        // out from the vertical, 5.00 artwork units
export const REPEAT_DOT_GAP2 = 7.16;      // ×2 · the pair straddles REPEAT_MID
export const REPEAT_DOT_GAP = 5.60;       // ×3 and ×4 · tighter, to keep the stack
                                          // inside the vertical at the enlarged radius

// The room one half of the mark takes on the page, ink included. The grab
// target, the selection outline and the ✕ badge are all placed off this, so
// the handle is the size of the brace rather than a fixed guess.
export const REPEAT_W = REPEAT_WING_X + NOTE_INK_W;   // 10.41 units

// The gap between the two braces when the pair is shown on its own — the
// Notation Guide's tile. Wide enough that the two flares do not close up into
// one lozenge, which is what the pair reads as once the tips get within a
// flare's length of each other. Not a staff measurement: nothing on the sheet
// is ever drawn from it.
export const REPEAT_PAIR_SPAN = 52;

// ---------- Visual theme of the staff ----------

export const STAFF = {
  // Measured off Files/OCTAVES NOTES PLACMENT.svg (class .fil2) and confirmed
  // against DNG NOTATION PAGE LAYOUT.svg — both drawings fill the band with
  // exactly this. It is paler than it looks on screen; do not "correct" it.
  greenFill: '#CBFFAD',
  stroke: '#000',
  strokeW: 1,
  noteInk: '#000',
  // What the symbol SOUNDING RIGHT NOW is drawn in. The playback highlight is
  // this colour and nothing else: no wash behind the beat, no block under the
  // glyph, no lift. The notation itself changes colour and everything around
  // it stays exactly as it was printed.
  //
  // It is the note's OWN ink, swapped at draw time (noteGlyph/restMark take it
  // as their last argument), not a CSS override of the finished glyph. That
  // matters because a hollow goli is `fill="none"` — the staff line has to run
  // through it — so a blanket `fill` rule would plug every open notehead the
  // moment it started sounding.
  playInk: 'var(--play-ink)',
  repeatInk: '#b8442b',
};

// ---------- Menus ----------

export const MENUS = {
  File: [
    ['New', 'newDoc', 'Ctrl+N'],
    ['Open varase…', 'openVarase', ''],
    ['—'],
    ['Reload preset', 'reload', ''],
    ['—'],
    ['Save (.json)', 'save', ''],
    ['Export PDF', 'exportPdf', ''],
    ['Export SVG', 'exportSvg', ''],
    ['Export MP3', 'exportMp3', ''],
    ['Export MIDI', 'exportMidi', ''],
    ['Print', 'print', ''],
  ],
  Edit: [
    ['Undo', 'undo', 'Ctrl+Z'],
    ['Redo', 'redo', 'Ctrl+Y'],
    ['—'],
    ['Clear notes', 'clearAll', ''],
    ['Clear repeat marks', 'clearBars', ''],
    ['—'],
    // What a PLAYED note is worth. These three are a radio group, not three
    // toggles — menus.js ticks whichever is current — so they are written
    // without a marker here and read as a set. See startHoldPromotion() in
    // score.js, which is the only place they differ.
    ['Value from how long you hold', 'holdTime', ''],
    ['Value from the selected symbol', 'holdFixed', ''],
    ['Selected symbol, or longer if held', 'holdPalette', ''],
  ],
  View: [
    ['Zoom In', 'zin', '+'],
    ['Zoom Out', 'zout', '−'],
    ['Reset Zoom', 'zreset', ''],
    ['—'],
    ['Toggle Light / Dark', 'theme', ''],
    ['Toggle Page View', 'page', ''],
    ['Toggle Row Marks', 'gutter', ''],
  ],
  // Sound plugins: one row per INSTRUMENTS entry, ticked by menus.js. Picking
  // one is the same as picking it in the toolbar's instrument dropdown.
  Plugins: INSTRUMENTS.map(i => [i.name, `inst:${i.id}`, '']),
  Help: [
    ['Notation Guide — what every symbol means', 'legend', ''],
    ['MIDI Monitor — everything the keyboard sends', 'midiMonitor', ''],
    ['Check for updates…', 'checkUpdates', ''],
    [`About ${APP_TITLE}`, 'about', ''],
    ['—'],
    ['Q W E R T Y U  →  taara  S R G M P D N', 'noop', ''],
    ['A S D F G H J  →  madhya  S R G M P D N', 'noop', ''],
    ['Z X C V B N M  →  mandra  S R G M P D N', 'noop', ''],
    ['⇧ + key  →  chromatic variant (filled goli)', 'noop', ''],
    [', / .  →  octave', 'noop', ''],
    ['Space  →  play', 'noop', ''],
    ['Ctrl+Z / Y  →  undo / redo', 'noop', ''],
  ],
};
