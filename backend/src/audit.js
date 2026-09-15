// The audit trail.
//
// Writes are fire-and-forget on purpose: an audit entry failing must never fail
// the action it was recording. A booking that succeeded and was not logged is a
// gap in the record; a booking that was refused because the logging failed is a
// customer who could not pay. The failure goes to CloudWatch, where the absence
// of an entry is at least visible.
//
// Nothing with a password, token, card number or full address goes in metadata.
// The table has no UPDATE grant (migrations/002_app_role.sql), so anything put
// here is permanent — including a mistake.

import { query } from './db.js';

export function audit({ userId = null, action, metadata = null, ipAddress = null }) {
  return query(
    `insert into audit_logs (user_id, action, metadata, ip_address)
     values ($1, $2, $3, $4)`,
    [userId, action, metadata ? JSON.stringify(metadata) : null, ipAddress]
  ).catch((err) => {
    console.error('[audit] write failed', action, err.message);
  });
}

// Fastify puts the API Gateway source IP in request.ip once trustProxy is on.
export function ipOf(request) {
  return request.ip || null;
}
