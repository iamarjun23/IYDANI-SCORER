// Cognito post-confirmation trigger: create the Postgres row for a person who
// has just proved they own their email address.
//
// Why a trigger rather than a call the app makes after its first login:
// it runs exactly once, server-side, at a moment the client cannot skip,
// reorder or fake. A client-driven "create my profile" call has to be
// idempotent, has to be authenticated, and still leaves a window where a
// confirmed account has no row — which /me/bootstrap exists to close, because
// this trigger can still fail (see below).
//
// TWO RULES, both of which Cognito enforces on us rather than the other way
// round:
//
//   1. NEVER throw. Cognito treats a failed post-confirmation trigger as a
//      failed confirmation and shows the user an error — but the account is
//      already confirmed by then, so they are told signup failed while in fact
//      they can log in. A database that is briefly unreachable must not produce
//      that. Errors are logged and swallowed; /me/bootstrap repairs the row on
//      first use.
//
//   2. Return the event object, unmodified. Cognito reads its response from the
//      returned value and a trigger that returns undefined fails the flow.

import { query } from '../db.js';

export async function handler(event) {
  try {
    const attrs = event.request?.userAttributes || {};
    const sub = attrs.sub;

    if (!sub) {
      console.error('[post-confirmation] event carried no sub', JSON.stringify(event.request || {}));
      return event;
    }

    const email = attrs.email || '';
    const displayName = attrs.name || email.split('@')[0] || 'Musician';

    // ON CONFLICT rather than a check-then-insert: Cognito can invoke a trigger
    // more than once for the same confirmation (its retry behaviour is not
    // contractual), and two invocations racing would otherwise leave one of
    // them raising a unique violation into rule 1 above.
    await query(
      `insert into users (cognito_sub, email, display_name)
       values ($1, $2, $3)
       on conflict (cognito_sub) do nothing`,
      [sub, email, displayName]
    );

    await query(
      `insert into audit_logs (user_id, action, metadata)
       select id, 'USER_REGISTERED', jsonb_build_object('source', 'cognito')
         from users where cognito_sub = $1`,
      [sub]
    );

    console.log('[post-confirmation] provisioned', sub);
  } catch (err) {
    // Rule 1. This is the whole reason the catch is here.
    console.error('[post-confirmation] failed, account will be repaired by /me/bootstrap:', err.message);
  }

  return event;
}
