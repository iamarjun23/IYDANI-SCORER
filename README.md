# IYDANI SCORER

**Write · Read · Play** — a desktop application for writing, hearing and
printing music in DNG notation.

> **Status: in active development.** The notation editor works and is ready for
> hands-on testing. Online accounts, cloud storage, bookings and live lessons
> are planned and partly built, but are **not live yet**.
> The current version number is in `package.json`.

---

## What it is

IYDANI SCORER lets a musician write Carnatic/DNG music on a measured DNG staff,
hear it played back, and print or export it as a finished sheet. It runs on the
computer by itself: **no internet connection and no account are needed** to
write, play, save or print music.

## What works today

### Writing music
- Enter notes by clicking an on-screen piano, typing on the computer keyboard
  (three letter rows = the three octaves), or playing a connected MIDI keyboard.
- How long a key is held decides the note value, so a held key can be written
  as a longer note without choosing a symbol first.
- All twelve tones across three octaves (mandra, madhya, taara), rests, dotted
  values, ties across divisions and ledger lines.
- Repeat marks, manual line breaks, the four talas at their true lengths, and
  custom time signatures (for example `3+2+2`).
- A piano-roll panel for editing one division by dragging, plus tabs, zoom and
  undo/redo.
- Svara labels in English, Kannada, Hindi, Telugu and Tamil, and light and dark
  themes.

### Hearing it
- Playback from recorded instrument samples, tuned to concert pitch (A = 440),
  with the note that is sounding highlighted on the sheet.
- A metronome that follows the tala, accenting the start of each group.
- Playback through a connected digital piano's own sound, and keeping time with
  the keyboard's metronome, either from the MIDI clock or by tapping along.

### Saving and sharing
- Save and open scores (`.dng.json`).
- Your open scores are saved automatically and come back when you reopen the
  app.
- Export to **PDF** (true-size A4 sheet), **SVG**, **MP3** and **MIDI**, or
  print directly.
- Import MIDI and MusicXML files. The melody is kept; the accompaniment is
  dropped.

## Progress at a glance

| Area | Progress | Notes |
|---|---:|---|
| Notation editor (offline) | ~85% | Entry, layout, playback, save, import and export all working |
| Audio and playback | ~80% | Recorded samples, sustain, metronome on one shared clock |
| MIDI keyboard support | ~75% | Live input, output to the keyboard, tempo sync, device monitor |
| Import and export | ~65% | PDF, SVG, MP3, MIDI, print |
| Desktop app and packaging | ~85% | Windows installer and portable build; Mac build set up |
| Accounts and cloud | ~20% | Sign-in written but not deployed |
| Live teaching and collaboration | ~3% | Screen mock-up only |
| Payments, bookings and marketplace | 0% | Razorpay chosen as the payment provider; not started |
| Automated testing | ~45% | 26 automated test suites, run automatically on every change |

Overall, the **standalone editor is about 85% complete**, and about **30% of the
full IYDANI product** (editor plus online platform) exists today.

## Known limitations

- Imported music is reduced to a single melody line.
- Repeats inside repeats are not supported; the app will not let you place one.
- Compressed MusicXML (`.mxl`) files cannot be opened; use `.xml` or
  `.musicxml`. There is no MusicXML export.
- The Windows installer is not code-signed yet, so Windows shows a SmartScreen
  warning on first install ("More info" → "Run anyway").
- The Mac build is unsigned until an Apple Developer account is set up.

## What comes next

1. **Tester round:** hand the current build to testers, collect problems, and
   fix and release in small numbered updates.
2. **Accounts go live:** deploy sign-in on Amazon Web Services (the
   code is written).
3. **Cloud scores (phase 2):** scores saved to the account and available on any
   computer.
4. **Bookings and payments (phase 3):** teacher profiles, lesson bookings and
   Razorpay payments.
5. **Later:** live lessons (voice, shared score, annotations, recording) and a
   marketplace.

## Installing and running

### For testers
Use the installer built into `release/`:
- `IYDANI-Scorer-<version>-x64.exe`: normal Windows installer.
- `IYDANI-Scorer-<version>-portable.exe`: runs without installing.

### For developers
Requires Node.js 20+ and npm.

```powershell
npm install        # one-time setup
npm start          # run the app
npm run verify     # run all automated checks
npm run build      # build the Windows installer and portable exe into release/
```

If `npm run build` fails with a `7za` symlink error, turn on Windows
**Developer Mode** (search "Developer Mode" in Windows Settings) or run the terminal
as Administrator, then build again.

The Mac build (`npm run build:mac`) has to be run on a Mac.

## How the project is organised

```text
src/               The desktop app (Electron)
  main.js          App window and security settings
  renderer/        The notation editor itself
  renderer/samples/  Recorded instrument notes
backend/           Account and data API (not deployed yet)
infra/terraform/   Cloud infrastructure definition (not deployed yet)
tests/             Automated tests
tools/             Build, version and checking scripts
```

**Security:** the editor runs in a locked-down window with no direct access to
the computer. Web links open in the normal browser, and sign-in tokens are kept
in the operating system's protected storage, never in plain files.

**Versioning:** every change bumps the version number, so any build can be traced
to exactly what was in it.

## License

Proprietary. © DNG Studios / Lyptron. All rights reserved.
