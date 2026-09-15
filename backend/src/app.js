// The Fastify app. Built the same way for Lambda (src/api.js) and for a local
// server (src/server.js) — nothing in here knows which one is running it, which
// is what makes "it works locally" mean something.

import Fastify from 'fastify';
import { config } from './config.js';
import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'prod' ? 'info' : 'debug',
      // The one header worth never printing. Fastify logs request headers at
      // debug level, and an access token in CloudWatch is a token anybody with
      // log access can replay until it expires.
      redact: ['req.headers.authorization', 'req.headers["x-razorpay-signature"]'],
    },

    // Behind API Gateway the socket address is the gateway's, so request.ip is
    // useless for the audit log without this. The gateway is the only thing
    // that can reach the Lambda, so the forwarded header cannot be spoofed by a
    // caller — which is exactly the condition under which trusting it is safe.
    trustProxy: true,

    // Razorpay signs the RAW body, so the webhook route needs the bytes as sent
    // rather than a re-serialised object. Captured for every request because
    // Fastify cannot add a parser for one route after the fact; it costs a
    // reference, not a copy.
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook('onRequest', async (request) => {
    request.startedAt = Date.now();
  });

  // One error shape for the whole API. Without this, a thrown Postgres error
  // reaches the client with its own message, which names tables and columns.
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err: error.message, stack: error.stack }, 'request failed');
      return reply.code(status).send({
        error: 'internal_error',
        message: 'Something went wrong. Please try again.',
      });
    }

    return reply.code(status).send({
      error: error.code || 'request_failed',
      message: error.message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  app.register(healthRoutes);
  app.register(meRoutes);

  return app;
}
