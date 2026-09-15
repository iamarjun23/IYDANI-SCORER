// Shared popover singleton. menus, language picker, cowork, zoom and tala
// menus all anchor to the same #pop element.

let popEl = null;
function el() { return popEl || (popEl = document.getElementById('pop')); }

// Whatever the popover was last opened from. The click that OPENS a popover
// also bubbles on to the dismiss handler below, so without remembering the
// anchor the menu closes in the same gesture that opened it.
let lastAnchor = null;

export function show(html, anchor, align = 'left') {
  const p = el();
  p.innerHTML = html;
  p.classList.add('show');
  lastAnchor = anchor || null;
  const r = anchor.getBoundingClientRect();
  p.style.top = (r.bottom + 5) + 'px';
  let left = r.left;
  if (align === 'right') left = r.right - p.offsetWidth;
  p.style.left = Math.max(8, Math.min(left, window.innerWidth - p.offsetWidth - 8)) + 'px';
}

export function hide() {
  lastAnchor = null;
  el().classList.remove('show');
  document.querySelectorAll('.menubar .m.open').forEach(m => m.classList.remove('open'));
}

export function pop() { return el(); }

// Click anywhere outside the popover or its anchor closes it.
//
// `anchorSelector` still names the always-known triggers, but the opening
// anchor is now excluded automatically as well — so a new trigger button works
// without having to be added to that list. #bOpen was missing from it, which is
// why the toolbar's open-file button appeared to do nothing: the popover was
// shown and then hidden again by the very same click.
export function installDismiss(anchorSelector) {
  document.addEventListener('click', e => {
    if (el().contains(e.target)) return;
    if (lastAnchor && lastAnchor.contains(e.target)) return;
    if (e.target.closest(anchorSelector)) return;
    hide();
  });
}
