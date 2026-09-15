// Local development server. Not deployed — Lambda uses src/api.js.

import { buildApp } from './app.js';
import { config } from './config.js';

const app = buildApp();

try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
