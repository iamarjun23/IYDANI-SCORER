// What platform this is running on, and the one thing that changes because of
// it: how a shortcut READS. The shortcut itself already works on both — every
// modifier check in the app is `e.ctrlKey || e.metaKey` (see keyboard.js), so
// Cmd has always fired the same handler as Ctrl. What was still wrong on a Mac
// was every label, tooltip and menu entry saying "Ctrl+N" for a key nobody on
// that platform would press.
//
// `platform.js` (not Node's own) because the renderer has no Node — the value
// comes from the *whitelisted* `window.hamsleka` bridge preload.js exposes,
// which is undefined in a plain browser (falls back to Windows-style labels,
// which is also correct there).

export function isMac() {
  return typeof window !== 'undefined' && window.hamsleka?.platform === 'darwin';
}

// "Ctrl+N" -> "⌘N" on a Mac; passed through unchanged everywhere else. Mac
// shortcuts are conventionally written without a "+", and Alt becomes Option.
export function shortcutLabel(text) {
  if (!text || !isMac()) return text;
  return text
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧');
}
