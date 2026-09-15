// Signing in.
//
// Cognito is talked to with plain fetch(), not with an AWS SDK. Its
// unauthenticated operations — SignUp, InitiateAuth, ForgotPassword and the
// rest — are ordinary JSON POSTs to one endpoint, distinguished by an
// X-Amz-Target header, and require no request signing at all. That matters
// here specifically: the renderer's CSP allows no CDN and this repo has no
// bundler, so every library has to be vendored by hand, and
// amazon-cognito-identity-js would be ~200 KB vendored to compute an SRP proof
// over a channel that is already TLS. The password reaches Cognito either way.
//
// WHERE THE TOKENS LIVE, which is the part that is not negotiable:
//
//   access token   in memory, in this module, for 15 minutes. Never written
//                  anywhere. A reload signs back in from the refresh token.
//   refresh token  in the OS keystore, through the preload bridge
//                  (src/secure-store.js). NEVER localStorage — that is a
//                  plaintext file any script in the renderer can read, and it
//                  is the one rule docs/roadmap/AUTH-FLOW.md states twice.
//
// The module reports changes with an 'auth:changed' document event rather than
// calling into the UI, the same way timesig.js reports a metre change — so the
// account UI and the menus can both listen without either importing the other.

import { state } from './state.js';

const REFRESH_KEY = 'refreshToken';

// Refresh this long before the access token actually expires. A token that
// expires mid-request produces a 401 the user sees as a failure; a minute of
// margin costs nothing and removes the whole class.
const REFRESH_MARGIN_MS = 60_000;

let config = null;
let configPromise = null;

// In memory only, for as long as the window lives.
let accessToken = null;
let accessTokenExpiry = 0;
let refreshPromise = null;

function bridge() {
  return globalThis.window?.hamsleka || null;
}

// The deployment's endpoints, from src/aws-config.json through the preload
// bridge. Fetched once. Everything here treats "not configured" as a normal
// state rather than an error: this is an offline notation editor that has
// gained an account system, not an app that requires one to start.
export async function awsConfig() {
  if (config) return config;

  if (!configPromise) {
    const b = bridge();
    configPromise = b?.awsConfig
      ? b.awsConfig().catch(() => null)
      : Promise.resolve(null);
  }

  config = (await configPromise) || {
    region: '', userPoolId: '', userPoolClientId: '', apiUrl: '', scoresBucketHost: '',
  };

  return config;
}

export async function isConfigured() {
  const c = await awsConfig();
  return Boolean(c.region && c.userPoolId && c.userPoolClientId);
}

// Cognito's own messages are written for developers ("User does not exist.",
// "1 validation error detected: ..."). These are what a musician should read
// instead. Anything not listed falls through to whatever Cognito said, which is
// better than a generic failure that hides a real cause.
export function messageFor(code) {
  switch (code) {
    case 'NotAuthorizedException':    return 'That email and password do not match.';
    case 'UserNotFoundException':     return 'That email and password do not match.';
    case 'UserNotConfirmedException': return 'Check your email for the confirmation code first.';
    case 'UsernameExistsException':   return 'An account with that email already exists.';
    case 'CodeMismatchException':     return 'That code is not right. Check it and try again.';
    case 'ExpiredCodeException':      return 'That code has expired. Ask for a new one.';
    case 'InvalidPasswordException':  return 'Password needs at least 8 characters, with a number, an uppercase and a lowercase letter.';
    case 'InvalidParameterException': return 'Check the details and try again.';
    case 'LimitExceededException':    return 'Too many attempts. Wait a few minutes and try again.';
    case 'TooManyRequestsException':  return 'Too many attempts. Wait a few minutes and try again.';
    case 'NotConfigured':             return 'No account service is configured for this build.';
    default:                          return 'Could not reach the account service.';
  }
}

// One Cognito operation. Errors come back as a __type field naming an exception
// class; they are turned into an Error carrying that name as `.code` so callers
// can branch on the condition rather than on a message string.
async function cognito(operation, body) {
  const c = await awsConfig();

  if (!c.region || !c.userPoolClientId) {
    throw Object.assign(new Error(messageFor('NotConfigured')), { code: 'NotConfigured' });
  }

  const res = await fetch(`https://cognito-idp.${c.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify({ ClientId: c.userPoolClientId, ...body }),
  });

  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* handled below */ }

  if (!res.ok) {
    const code = String(payload.__type || '').split('#').pop() || 'CognitoError';
    throw Object.assign(new Error(payload.message || messageFor(code)), { code, status: res.status });
  }

  return payload;
}

async function storeRefresh(token) {
  const b = bridge();
  if (!b?.secureStore) return false;
  try { return await b.secureStore.set(REFRESH_KEY, token); } catch { return false; }
}

async function readRefresh() {
  const b = bridge();
  if (!b?.secureStore) return null;
  try { return await b.secureStore.get(REFRESH_KEY); } catch { return null; }
}

async function clearRefresh() {
  const b = bridge();
  if (!b?.secureStore) return;
  try { await b.secureStore.delete(REFRESH_KEY); } catch { /* nothing to undo */ }
}

function announce() {
  try {
    document.dispatchEvent(new CustomEvent('auth:changed', { detail: { user: state.user } }));
  } catch { /* no DOM in a plain-Node test run */ }
}

function applyTokens(result) {
  accessToken = result.AccessToken || null;
  // ExpiresIn is seconds from now, per the Cognito API.
  accessTokenExpiry = Date.now() + (Number(result.ExpiresIn || 900) * 1000);
  // A refresh response omits RefreshToken — the existing one stays valid, so
  // absence here means "keep what you have", never "you have been logged out".
  return result.RefreshToken || null;
}

// ---- the operations ------------------------------------------------------

export async function register({ email, password, displayName }) {
  await cognito('SignUp', {
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: displayName || email.split('@')[0] },
    ],
  });

  // Cognito emails a six-digit code; the account cannot sign in until it is
  // confirmed. Returned rather than assumed so the UI can say so plainly.
  return { needsConfirmation: true, email };
}

export async function confirmRegistration({ email, code }) {
  await cognito('ConfirmSignUp', { Username: email, ConfirmationCode: code });
  return true;
}

export async function resendCode(email) {
  await cognito('ResendConfirmationCode', { Username: email });
  return true;
}

export async function signIn({ email, password }) {
  const res = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  // A pool configured to demand a new password or an MFA code answers with a
  // ChallengeName instead of tokens. Neither is switched on (see
  // infra/terraform/cognito.tf), so rather than half-implement a challenge
  // handler that has never run, this says plainly what happened.
  if (!res.AuthenticationResult) {
    throw Object.assign(
      new Error(`This account needs a step this version cannot complete (${res.ChallengeName || 'unknown challenge'}).`),
      { code: 'ChallengeRequired' },
    );
  }

  const refresh = applyTokens(res.AuthenticationResult);
  if (refresh) await storeRefresh(refresh);

  await loadProfile();
  return state.user;
}

// Exchange the stored refresh token for a new access token. Concurrent callers
// share ONE in-flight request: several API calls waking together after the
// token expires would otherwise each start their own refresh, and Cognito
// invalidates a refresh token as it is used, so the second one through would
// fail against a token the first had already spent.
async function refreshSession() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const token = await readRefresh();
    if (!token) return null;

    try {
      const res = await cognito('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: token },
      });

      if (!res.AuthenticationResult) return null;
      const rotated = applyTokens(res.AuthenticationResult);
      if (rotated) await storeRefresh(rotated);
      return accessToken;
    } catch (err) {
      // A refresh token Cognito refuses is spent, revoked or expired — there is
      // no recovering it, and keeping it means every future launch retries a
      // credential that will never work again.
      if (err.code === 'NotAuthorizedException') {
        await clearRefresh();
        accessToken = null;
        accessTokenExpiry = 0;
        state.user = null;
        announce();
      }
      return null;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// What api.js calls before every request. Returns null when there is no
// session, which is a normal answer, not a failure.
export async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - REFRESH_MARGIN_MS) {
    return accessToken;
  }
  return refreshSession();
}

export function signedIn() {
  return Boolean(state.user);
}

// Called at startup. A stored refresh token is what makes the app open already
// signed in; without one this returns null and the app is exactly what it was
// before accounts existed.
export async function restoreSession() {
  if (!(await isConfigured())) return null;

  const token = await refreshSession();
  if (!token) return null;

  await loadProfile();
  return state.user;
}

async function loadProfile() {
  // Imported here rather than at the top because api.js imports this module —
  // a static cycle between the two would leave one of them half-initialised
  // depending on which the browser evaluated first.
  const { apiGet } = await import('./api.js');

  try {
    state.user = await apiGet('/me');
  } catch (err) {
    // A verified token whose row does not exist yet: the Cognito trigger has
    // not run, or failed. api.js already tried the repair; if it still fails,
    // the session is real but the profile is not, and showing an account UI
    // with nothing behind it would be worse than showing none.
    if (err.code === 'account_not_provisioned') {
      state.user = null;
    } else {
      throw err;
    }
  }

  announce();
  return state.user;
}

export async function signOut() {
  const token = accessToken;

  accessToken = null;
  accessTokenExpiry = 0;
  state.user = null;
  await clearRefresh();
  announce();

  // Tell Cognito last, and do not let it fail the sign-out. Local state is
  // already clear by this point — a network error here would otherwise leave
  // somebody unable to sign out of a machine they are trying to leave.
  if (token) {
    try { await cognito('GlobalSignOut', { AccessToken: token }); } catch { /* already gone locally */ }
  }
}

export async function forgotPassword(email) {
  await cognito('ForgotPassword', { Username: email });
  return true;
}

export async function resetPassword({ email, code, password }) {
  await cognito('ConfirmForgotPassword', {
    Username: email,
    ConfirmationCode: code,
    Password: password,
  });
  return true;
}
