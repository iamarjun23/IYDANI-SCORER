// Cowork: a teacher writes a song and makes a lesson of it, a student opens the
// lesson and plays it. The play-along judging is lesson.js; this is the bar.
//
// IT IS A BAR ON THE EDITOR, NOT A PAGE. A page of its own was built first and
// refused: it gave the teacher somewhere to upload a song and nowhere to write
// one, when the whole editor for writing it was already on screen behind it.
// So the teacher's view IS the default screen, with one bar added to it.
//
// A LESSON FILE IS A SCORE FILE — the same .dng.json File ▸ Save writes — so
// there is no second format, and anything the editor can open (a MIDI or
// MusicXML import included) becomes a lesson by opening it and pressing Save
// as lesson. There is no server in this: the teacher saves the file and sends
// it, the student opens it. Lessons on this machine are kept in localStorage.
// ponytail: one list for both roles, no students and no results going back to
// the teacher. That needs the backend's Phase 2 (cloud scores) — add it there.

import { state, docs } from './state.js';
import { semiOf } from './config.js';
import { render } from './notation.js';
import { loadDoc, saveDoc } from './tabs.js';
import { scoreData, saveJSON } from './io.js';
import { registerTala, allTalas } from './timesig.js';
import { togglePlay, stopPlay } from './playback.js';
import { writtenFor } from './piano.js';
import { startLesson, endLesson, setLessonMode, lessonScore } from './lesson.js';

const STORE = 'dng.lessons.v1';
const $ = id => document.getElementById(id);

// Anything in the store that is not shaped like a lesson is dropped.
function lessons() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(list) ? list.filter(l => l && Array.isArray(l.notes)) : [];
  } catch { return []; }
}

function keep(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* full or blocked */ }
}

const noteCount = l => l.notes.filter(n => n.type === 'note').length;

let msg = '';
// The lesson the picker should land on after a repaint.
let picked = null;

// A lesson is named by its title, so saving the song again as the teacher goes
// on writing it UPDATES the lesson rather than piling up copies.
function addLesson(data, fallbackTitle) {
  if (!data || !Array.isArray(data.notes) || !data.notes.some(n => n.type === 'note')) {
    msg = 'There are no notes in that score yet.';
    return;
  }
  const title = data.title || fallbackTitle || 'Untitled';
  const list = lessons();
  const old = list.find(l => l.title === title);
  picked = old ? old.id : Date.now().toString(36);
  keep([...list.filter(l => l !== old), { ...data, title, id: picked, best: null }]);
  msg = old ? 'Lesson updated.' : 'Lesson saved.';
}

async function takeFile(file) {
  if (!file) return;
  try {
    addLesson(JSON.parse(await file.text()), file.name.replace(/\.(dng\.)?json$/i, ''));
  } catch (err) {
    msg = 'Could not open that file: ' + err.message;
  }
  paint();
}

function paint() {
  const L = state.lesson;
  document.querySelectorAll('#cwRole button').forEach(b =>
    b.classList.toggle('active', b.dataset.r === state.cwRole));
  $('cwHome').hidden = !!L;
  $('cwLesson').hidden = !L;
  document.querySelectorAll('#cwHome [data-for]').forEach(el => {
    el.hidden = el.dataset.for !== state.cwRole;
  });

  // A title is somebody else's text: an Option, never markup.
  const pick = $('cwPick');
  const all = lessons();
  pick.replaceChildren(...all.map(l => {
    const n = noteCount(l);
    return new Option(l.title + ' · ' + n + ' notes'
      + (l.best != null ? ' · best ' + l.best + ' / ' + n : ''), l.id);
  }));
  if (!all.length) pick.add(new Option('No lessons yet', ''));
  if (all.some(l => l.id === picked)) pick.value = picked;
  $('cwMsg').textContent = msg;
}

const chosen = () => lessons().find(l => l.id === $('cwPick').value);

// ---------- playing a lesson ----------

function openLesson(l) {
  if (state.playing) stopPlay();
  saveDoc();
  // As a file open does: the metre's definition before its name, and the tonic.
  if (l.timeSig) registerTala(l.timeSig);
  state.saMidi = Number(l.saMidi) || 60;
  // Its own tab, on a copy, so the lesson in the list is never what is touched.
  docs.push({
    notes: structuredClone(l.notes), bars: l.bars || [], breaks: l.breaks || [],
    tones: l.tones, lastBreak: null, title: l.title, preset: null,
    tala: allTalas()[l.tala] ? l.tala : 'chatusra', bpm: l.bpm || 72,
  });
  loadDoc(docs.length - 1);
  startLesson(l.id, 'play');
}

// Ring the key being waited for. Works on both keyboards: the app's own keys
// carry a semitone and sthayi, the device's carry a MIDI number.
// ponytail: buildPiano() rewrites the keys and the ring goes with them until
// the next key is played. Repaint from there if that is ever noticed.
function lightNext(n) {
  const keys = $('pianoKeys');
  keys.querySelectorAll('.next').forEach(k => k.classList.remove('next'));
  if (!n) return;
  const abs = n.oct * 12 + semiOf(n.svaraIndex, n.head);
  const semi = ((abs % 12) + 12) % 12;
  const oct = Math.floor(abs / 12);
  keys.querySelectorAll('[data-semi],[data-midi]').forEach(k => {
    const w = k.dataset.midi != null
      ? writtenFor(+k.dataset.midi)
      : { semi: +k.dataset.semi, oct: +k.dataset.oct };
    if (w && w.semi === semi && w.oct === oct) k.classList.add('next');
  });
}

function onLesson() {
  const L = state.lesson;
  // A lesson is always played with its bar showing.
  if (L) $('coworkBar').hidden = false;
  document.body.classList.toggle('lesson', !!L);
  const play = !!L && L.mode === 'play';
  // The note being waited for is drawn in the playback ink, like one sounding.
  if (!state.playing) state.hlIndex = play && L.pos >= 0 ? L.pos : null;
  lightNext(play ? state.notes[L.pos] : null);
  $('lsnScore').textContent = '';
  if (L) {
    $('lsnTitle').textContent = state.title;
    document.querySelectorAll('#lsnMode button').forEach(b =>
      b.classList.toggle('active', b.dataset.m === L.mode));
    $('lsnGo').textContent = play ? 'Start again' : 'Play / stop';
    const { hits, total } = lessonScore();
    const done = play && L.pos < 0;
    if (play) $('lsnScore').textContent = (done ? 'Finished · ' : 'Hit ') + hits + ' / ' + total;
    if (done) {
      keep(lessons().map(l => (l.id === L.id ? { ...l, best: Math.max(l.best ?? 0, hits) } : l)));
    }
  }
  paint();
  render();
  document.querySelector('#score [data-active="1"]')
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function wireCowork() {
  // The header button puts the bar away and brings it back. Not while a lesson
  // is open: its controls are the only way out of one.
  $('coworkBtn').addEventListener('click', () => {
    if (!state.lesson) $('coworkBar').hidden = !$('coworkBar').hidden;
  });
  $('cwRole').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.cwRole = b.dataset.r;
    msg = '';
    paint();
  });

  $('cwAdd').addEventListener('click', () => { addLesson(scoreData()); paint(); });
  $('cwOpen').addEventListener('click', () => $('cwFile').click());
  $('cwFile').addEventListener('change', e => {
    takeFile(e.target.files[0]);
    e.target.value = '';
  });
  $('cwPick').addEventListener('change', e => { picked = e.target.value; });

  // Each of these acts on the lesson in the picker, and says so when there is
  // none rather than sitting there disabled with no reason given.
  const onPicked = (id, act) => $(id).addEventListener('click', () => {
    const l = chosen();
    if (l) act(l);
    else { msg = 'No lessons yet.'; paint(); }
  });
  onPicked('cwSave', saveJSON);
  onPicked('cwPlay', openLesson);
  onPicked('cwDel', l => {
    keep(lessons().filter(x => x.id !== l.id));
    msg = '';
    paint();
  });

  $('lsnExit').addEventListener('click', () => {
    if (state.playing) stopPlay();
    endLesson();
  });
  $('lsnMode').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (state.playing) stopPlay();
    setLessonMode(b.dataset.m);
  });
  $('lsnGo').addEventListener('click', () => {
    if (state.lesson.mode === 'play') setLessonMode('play');
    else togglePlay();
  });
  document.addEventListener('lesson:changed', onLesson);
  paint();
}
