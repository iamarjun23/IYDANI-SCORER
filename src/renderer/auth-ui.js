// The account dialog: sign in, register, confirm an emailed code, reset a
// forgotten password.
//
// One dialog with four VIEWS rather than four dialogs, because they are one
// errand — somebody trying to get into their account — and the paths between
// them are not optional: registering always leads to a code, and a wrong
// password commonly leads to a reset. Separate modals would mean closing one to
// open the next and retyping the email each time.
//
// It reuses the legend's .lgd-scrim/.lgd card, as about.js and the keymap and
// time-signature dialogs already do, so this adds no second modal idiom. The
// keyboard rules come with it and are not decoration: the staff behind is
// listening for letter keys, so a password typed over an unguarded dialog would
// also write notes onto the score.

import {
  register, confirmRegistration, resendCode, signIn, signOut,
  forgotPassword, resetPassword, isConfigured, messageFor, restoreSession,
} from './auth.js';
import { state } from './state.js';

let view = 'signin';       // 'signin' | 'register' | 'confirm' | 'forgot' | 'reset'
let pending = '';          // the email being confirmed or reset, carried between views
let busy = false;
let wired = false;

function overlay() { return document.getElementById('authOverlay'); }
function body() { return document.getElementById('authBody'); }

function title() {
  switch (view) {
    case 'register': return 'Create an account';
    case 'confirm':  return 'Confirm your email';
    case 'forgot':   return 'Reset your password';
    case 'reset':    return 'Choose a new password';
    default:         return 'Sign in';
  }
}

// Every value that reaches the DOM as text goes through this. A display name is
// the user's own text and is echoed back into innerHTML below; without escaping,
// a name containing a tag is markup. The CSP stops it executing — it does not
// stop it wrecking the panel, and relying on the CSP for the rest is not a
// defence worth keeping (the same argument midi-input.js makes about device
// names in the picker).
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function field(id, label, type, value = '', extra = '') {
  return `
    <label class="auth-field">
      <span>${label}</span>
      <input id="${id}" type="${type}" value="${esc(value)}" ${extra} autocomplete="off" spellcheck="false">
    </label>`;
}

function viewHtml() {
  switch (view) {
    case 'register':
      return `
        ${field('authName', 'Your name', 'text')}
        ${field('authEmail', 'Email', 'email', pending)}
        ${field('authPassword', 'Password', 'password', '', 'minlength="8"')}
        <div class="auth-hint">At least 8 characters, with a number, an uppercase and a lowercase letter.</div>
        <button class="auth-go" id="authSubmit">Create account</button>
        <div class="auth-alt">Already have an account? <button class="auth-link" data-view="signin">Sign in</button></div>`;

    case 'confirm':
      return `
        <div class="auth-hint">We emailed a six-digit code to <b>${esc(pending)}</b>.</div>
        ${field('authCode', 'Confirmation code', 'text', '', 'inputmode="numeric" maxlength="6"')}
        <button class="auth-go" id="authSubmit">Confirm</button>
        <div class="auth-alt">
          <button class="auth-link" id="authResend">Send a new code</button>
          &nbsp;·&nbsp;
          <button class="auth-link" data-view="signin">Back to sign in</button>
        </div>`;

    case 'forgot':
      return `
        <div class="auth-hint">We will email you a code to set a new password with.</div>
        ${field('authEmail', 'Email', 'email', pending)}
        <button class="auth-go" id="authSubmit">Send code</button>
        <div class="auth-alt"><button class="auth-link" data-view="signin">Back to sign in</button></div>`;

    case 'reset':
      return `
        <div class="auth-hint">Enter the code we emailed to <b>${esc(pending)}</b> and a new password.</div>
        ${field('authCode', 'Code', 'text', '', 'inputmode="numeric" maxlength="6"')}
        ${field('authPassword', 'New password', 'password', '', 'minlength="8"')}
        <button class="auth-go" id="authSubmit">Set password</button>
        <div class="auth-alt"><button class="auth-link" data-view="signin">Back to sign in</button></div>`;

    default:
      return `
        ${field('authEmail', 'Email', 'email', pending)}
        ${field('authPassword', 'Password', 'password')}
        <button class="auth-go" id="authSubmit">Sign in</button>
        <div class="auth-alt">
          <button class="auth-link" data-view="forgot">Forgot password?</button>
          &nbsp;·&nbsp;
          <button class="auth-link" data-view="register">Create an account</button>
        </div>`;
  }
}

function signedInHtml() {
  const user = state.user;
  const initial = esc((user.displayName || user.email || '?').trim().charAt(0).toUpperCase());

  return `
    <div class="auth-who">
      <div class="auth-av">${initial}</div>
      <div>
        <b>${esc(user.displayName)}</b>
        <small>${esc(user.email)}</small>
      </div>
    </div>
    <div class="auth-role">Signed in as <b>${user.role === 'TEACHER' ? 'a teacher' : 'a student'}</b></div>
    <button class="auth-go ghost" id="authSignOut">Sign out</button>`;
}

function render(message = '', tone = 'error') {
  const el = body();
  if (!el) return;

  document.getElementById('authTitle').textContent = state.user ? 'Your account' : title();

  const note = message ? `<div class="auth-note ${tone}">${esc(message)}</div>` : '';
  el.innerHTML = state.user ? signedInHtml() + note : viewHtml() + note;

  if (busy) {
    el.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
  }

  // Focus the first empty field so the dialog can be typed into immediately —
  // and the first EMPTY one, so an email carried over from the previous view is
  // not what the cursor lands in.
  const first = [...el.querySelectorAll('input')].find((i) => !i.value);
  if (first) first.focus();
}

function go(next, message = '') {
  view = next;
  render(message, 'info');
}

function value(id) {
  return (document.getElementById(id)?.value || '').trim();
}

// Every submit runs through this: it holds the dialog while the request is in
// flight (a second click on "Sign in" would otherwise start a second sign-in)
// and turns whatever comes back into one readable line.
async function attempt(work) {
  if (busy) return;
  busy = true;
  render('Working…', 'info');

  try {
    await work();
  } catch (err) {
    busy = false;
    render(err.code ? (err.message || messageFor(err.code)) : (err.message || 'Something went wrong.'), 'error');
    return;
  }

  busy = false;
}

async function submit() {
  if (view === 'register') {
    const email = value('authEmail');
    const password = value('authPassword');
    const displayName = value('authName');

    if (!email || !password) return render('Email and password are both needed.', 'error');

    await attempt(async () => {
      await register({ email, password, displayName });
      pending = email;
      go('confirm', 'Account created. Check your email for the code.');
    });
    return;
  }

  if (view === 'confirm') {
    const code = value('authCode');
    if (!code) return render('Enter the code from your email.', 'error');

    await attempt(async () => {
      await confirmRegistration({ email: pending, code });
      go('signin', 'Email confirmed. Sign in to continue.');
    });
    return;
  }

  if (view === 'forgot') {
    const email = value('authEmail');
    if (!email) return render('Enter the email you registered with.', 'error');

    await attempt(async () => {
      await forgotPassword(email);
      pending = email;
      go('reset', 'Code sent. Check your email.');
    });
    return;
  }

  if (view === 'reset') {
    const code = value('authCode');
    const password = value('authPassword');
    if (!code || !password) return render('Both the code and a new password are needed.', 'error');

    await attempt(async () => {
      await resetPassword({ email: pending, code, password });
      go('signin', 'Password changed. Sign in with it.');
    });
    return;
  }

  const email = value('authEmail');
  const password = value('authPassword');
  if (!email || !password) return render('Email and password are both needed.', 'error');

  await attempt(async () => {
    try {
      await signIn({ email, password });
      closeAuth();
    } catch (err) {
      // Registered but never confirmed. Sending them straight to the code
      // screen is the whole fix; telling them "not confirmed" and leaving them
      // on the sign-in form is not.
      if (err.code === 'UserNotConfirmedException') {
        pending = email;
        await resendCode(email).catch(() => {});
        go('confirm', 'This account still needs confirming. We sent a new code.');
        return;
      }
      throw err;
    }
  });
}

export function openAuth() {
  const el = overlay();
  if (!el) return;

  view = 'signin';
  busy = false;
  el.hidden = false;

  isConfigured().then((ok) => {
    render(ok ? '' : 'No account service is configured for this build — the editor works offline as usual.', ok ? 'error' : 'info');
  });
}

export function closeAuth() {
  const el = overlay();
  if (el) el.hidden = true;
}

export function wireAuth() {
  const el = overlay();
  if (el && !wired) {
    wired = true;

    document.getElementById('authClose').addEventListener('click', closeAuth);
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeAuth(); });

    // Captured on the way DOWN so it lands before the note-entry listener: the
    // staff behind is listening for letter keys, and a password typed over an
    // unguarded dialog writes notes onto the score as well.
    document.addEventListener('keydown', (e) => {
      if (el.hidden) return;
      if (e.key === 'Escape') closeAuth();
      if (e.key === 'Enter' && !busy) { e.preventDefault(); submit(); }
      e.stopPropagation();
    }, true);

    // One delegated listener rather than rebinding after every render() — the
    // body is rewritten on each view change, so handlers attached to its
    // children would be thrown away with them.
    body().addEventListener('click', (e) => {
      const link = e.target.closest('[data-view]');
      if (link) { pending = value('authEmail') || pending; return go(link.dataset.view); }

      if (e.target.closest('#authSubmit')) return submit();
      if (e.target.closest('#authSignOut')) return attempt(async () => { await signOut(); closeAuth(); });
      if (e.target.closest('#authResend')) {
        return attempt(async () => {
          await resendCode(pending);
          render('A new code is on its way.', 'info');
        });
      }
    });
  }

  // The dialog redraws itself when the session changes, whoever changed it —
  // a token expiring in the background signs you out, and a dialog still
  // showing your name after that would be lying.
  document.addEventListener('auth:changed', () => {
    if (!overlay()?.hidden) render();
  });
}

// The header button says who is signed in without anything being opened: an
// outline avatar when nobody is, the person's initial when somebody is. It is
// the only place in the chrome that reports a session, so leaving it static
// would mean a token quietly expiring with nothing on screen changing.
function paintAccountButton() {
  const btn = document.getElementById('profileBtn');
  if (!btn) return;

  const user = state.user;

  if (!user) {
    btn.classList.remove('signed-in');
    btn.title = 'Sign in';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>`;
    return;
  }

  btn.classList.add('signed-in');
  btn.title = `${user.displayName} — ${user.email}`;
  btn.textContent = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase();
}

// Called once at startup. Restoring a session is a NETWORK round trip, so it is
// deliberately not awaited by init() — the editor opens at its normal speed and
// the account fills itself in a moment later. A machine with no backend
// configured, or no network, simply stays signed out; nothing here can prevent
// the app from starting, which is the whole point of an offline-first editor
// that has gained accounts rather than one that requires them.
export function initAccount() {
  paintAccountButton();
  document.addEventListener('auth:changed', paintAccountButton);

  restoreSession().catch((err) => {
    console.warn('[auth] could not restore the previous session:', err.message);
  });
}
