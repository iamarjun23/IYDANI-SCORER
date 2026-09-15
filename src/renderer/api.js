// Every call to the backend goes through here.
//
// One place, for three reasons that each caused a bug the first time somebody
// wrote fetch() by hand somewhere else: the bearer token has to be attached and
// refreshed before the request rather than after a 401; an error response has
// to become a thrown Error carrying the server's own `error` code, or callers
// end up matching on message strings that change; and a 409
// account_not_provisioned has to be repaired rather than surfaced, because it
// is a race with the Cognito trigger and not something a user can act on.

import { awsConfig, currentAccessToken } from './auth.js';

// A request the network never answers has to end somewhere. Without this the
// UI keeps a spinner up forever on a dropped connection, which reads as the app
// having hung.
const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'request_failed';
    this.status = status || 0;
    this.body = body || null;
  }
}

async function baseUrl() {
  const c = await awsConfig();
  if (!c.apiUrl) {
    throw new ApiError('No account service is configured for this build.', { code: 'not_configured' });
  }
  return c.apiUrl.replace(/\/+$/, '');
}

async function request(method, path, { body, auth = true, retryProvision = true } = {}) {
  const url = `${await baseUrl()}${path}`;

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const token = await currentAccessToken();
    if (!token) {
      throw new ApiError('You are not signed in.', { code: 'unauthorized', status: 401 });
    }
    headers.Authorization = `Bearer ${token}`;
  }

  // AbortSignal.timeout() would be shorter, but it is only in Chromium 103+ and
  // this spelling works everywhere the app runs, including a plain-Node test.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // An abort and a DNS failure are both "the server did not answer", and the
    // distinction is not one a person can do anything with.
    throw new ApiError(
      err.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the server.',
      { code: 'network_error' },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* handled below */ }

  if (res.ok) return payload;

  const code = payload?.error || 'request_failed';

  // The one error worth handling rather than reporting. A token verifies but
  // the row behind it does not exist yet — the post-confirmation trigger has
  // not landed. /me/bootstrap creates it idempotently, so this retries once and
  // the user never learns any of it happened. Once, not in a loop: if bootstrap
  // itself cannot create the row, something is actually wrong and repeating the
  // request will not fix it.
  if (res.status === 409 && code === 'account_not_provisioned' && retryProvision) {
    await request('POST', '/me/bootstrap', { retryProvision: false });
    return request(method, path, { body, auth, retryProvision: false });
  }

  throw new ApiError(payload?.message || `Request failed (${res.status})`, {
    code,
    status: res.status,
    body: payload,
  });
}

export const apiGet = (path) => request('GET', path);
export const apiPost = (path, body) => request('POST', path, { body });
export const apiPatch = (path, body) => request('PATCH', path, { body });
export const apiDelete = (path) => request('DELETE', path);

// Unauthenticated — used by the account UI to say whether the backend is up at
// all, which is a different question from whether you are signed in.
export async function apiHealth() {
  try {
    await request('GET', '/health', { auth: false });
    return true;
  } catch {
    return false;
  }
}
