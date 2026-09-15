// Public. Unauthenticated on purpose (infra/terraform/apigateway.tf routes it
// past the JWT authorizer) — it is what tells you whether the stack is up when
// you cannot log in, which is exactly when you need to know.

import { query } from '../db.js';

export default async function healthRoutes(app) {
  app.get('/health', async () => ({ ok: true, service: 'iydani-api' }));

  // Separate from /health because they answer different questions. /health says
  // the Lambda runs; this says the Lambda can reach the database. A single
  // endpoint doing both means a database outage reads as a total outage.
  app.get('/health/db', async (request, reply) => {
    try {
      const res = await query('select now() as now');
      return { ok: true, now: res.rows[0].now };
    } catch (err) {
      request.log.error({ err: err.message }, 'db health check failed');
      return reply.code(503).send({ ok: false, error: 'database_unreachable' });
    }
  });
}
