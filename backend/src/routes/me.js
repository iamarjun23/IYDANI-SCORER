// The signed-in person: read their profile, edit it, become a teacher.
//
// Everything here is scoped to request.user — there is no user id in any path,
// so there is no id to tamper with. Reading somebody ELSE's profile is the
// marketplace's business (a teacher's public card), not this file's.

import { requireUser, requireToken } from '../auth.js';
import { queryOne } from '../db.js';
import { audit, ipOf } from '../audit.js';

// What goes over the wire. Explicit rather than `select *`, so a column added
// later — a Razorpay id, an internal flag — is not published by accident.
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    role: row.role,
    timezone: row.timezone,
    geoRegion: row.geo_region,
    onboardedAt: row.onboarded_at,
    createdAt: row.created_at,
  };
}

export default async function meRoutes(app) {
  app.get('/me', { preHandler: [requireUser] }, async (request) => publicUser(request.user));

  // The repair path for a verified token with no row.
  //
  // The post-confirmation trigger (src/triggers/post-confirmation.js) is what
  // normally creates it, and it is the right place — it runs once, server-side,
  // at the moment the email is proven. But it can fail: a Lambda cold start
  // past Cognito's 5-second trigger timeout, a database briefly unreachable, or
  // a user pool that existed before the trigger was attached. Cognito does not
  // retry it and the account is confirmed regardless, so without this endpoint
  // that person can log in forever and never have a profile.
  //
  // Idempotent — ON CONFLICT makes a second call return the existing row rather
  // than fail, which matters because the client calls this whenever it sees the
  // 409 and two requests can easily overlap.
  app.post('/me/bootstrap', { preHandler: [requireToken] }, async (request, reply) => {
    const claims = request.claims;
    const email = claims.email || claims.username || '';

    const row = await queryOne(
      `insert into users (cognito_sub, email, display_name)
       values ($1, $2, $3)
       on conflict (cognito_sub) do update
         set updated_at = now()
       returning *`,
      [claims.sub, email, claims.name || email.split('@')[0] || 'Musician']
    );

    audit({ userId: row.id, action: 'USER_BOOTSTRAPPED', ipAddress: ipOf(request) });
    return reply.code(201).send(publicUser(row));
  });

  app.patch('/me', { preHandler: [requireUser] }, async (request, reply) => {
    const body = request.body || {};

    // Only these four. Role is NOT among them — becoming a teacher is its own
    // endpoint below, because it is a state change with consequences (a public
    // profile, a payout account) rather than a field edit. Nothing here can
    // change email either: that is Cognito's, and changing it there without
    // re-verification would let somebody claim an address they do not own.
    const fields = [];
    const values = [];

    for (const [column, value] of [
      ['display_name', body.displayName],
      ['bio', body.bio],
      ['avatar_url', body.avatarUrl],
      ['timezone', body.timezone],
    ]) {
      if (value !== undefined) {
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      }
    }

    if (!fields.length) {
      return reply.code(400).send({ error: 'no_fields', message: 'Nothing to update.' });
    }

    values.push(request.user.id);

    const row = await queryOne(
      `update users set ${fields.join(', ')}
        where id = $${values.length}
          and deleted_at is null
        returning *`,
      values
    );

    audit({
      userId: row.id,
      action: 'USER_UPDATED',
      metadata: { fields: fields.map((f) => f.split(' ')[0]) },
      ipAddress: ipOf(request),
    });

    return publicUser(row);
  });

  // Marks the onboarding wizard finished. A separate endpoint rather than a
  // PATCH field because it is a timestamp the client should not be able to set
  // to an arbitrary value.
  app.post('/me/onboarded', { preHandler: [requireUser] }, async (request) => {
    const row = await queryOne(
      `update users set onboarded_at = coalesce(onboarded_at, now())
        where id = $1
        returning *`,
      [request.user.id]
    );

    audit({ userId: row.id, action: 'USER_ONBOARDED', ipAddress: ipOf(request) });
    return publicUser(row);
  });
}
