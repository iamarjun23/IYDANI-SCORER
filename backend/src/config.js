// Configuration, resolved once per container.
//
// Two sources: plain environment variables for things that are not secret (set
// on the function in infra/terraform/lambda.tf), and Secrets Manager for the
// two that are. Nothing here reads process.env at call sites — a value that can
// be undefined in one code path and defined in another is a bug that only shows
// up in the environment nobody tested.

import { readSecret } from './secrets.js';

const env = process.env;

export const config = {
  nodeEnv: env.NODE_ENV || 'dev',
  port: Number(env.PORT) || 3000,
  region: env.AWS_REGION_NAME || env.AWS_REGION || 'ap-south-1',

  cognito: {
    userPoolId: env.COGNITO_USER_POOL_ID || '',
    clientId: env.COGNITO_CLIENT_ID || '',
  },

  scoresBucket: env.SCORES_BUCKET || '',

  // A whole percent, not a fraction: 15 means IYDANI keeps 15% and the teacher
  // receives 85% through Razorpay Route.
  platformFeePercent: Number(env.PLATFORM_FEE_PERCENT ?? 15),

  isLambda: Boolean(env.AWS_LAMBDA_FUNCTION_NAME),
};

// The database URL comes from Secrets Manager in Lambda and from .env locally.
// Resolved lazily and cached, because a cold start that cannot reach Secrets
// Manager should fail on the first REQUEST with a readable error rather than at
// import time with a stack trace inside the runtime bootstrap.
let dbUrlPromise = null;

export function databaseUrl() {
  if (env.DATABASE_URL) return Promise.resolve(env.DATABASE_URL);

  if (!env.DB_SECRET_ARN) {
    return Promise.reject(
      new Error('Neither DATABASE_URL nor DB_SECRET_ARN is set — the API has no database to talk to.')
    );
  }

  if (!dbUrlPromise) {
    dbUrlPromise = readSecret(env.DB_SECRET_ARN).then((secret) => {
      if (!secret.url) throw new Error(`Secret ${env.DB_SECRET_ARN} has no "url" field.`);
      return secret.url;
    });
    // A failed lookup must not be cached as a permanent failure — a transient
    // Secrets Manager error would otherwise poison the container for its whole
    // lifetime, and a warm Lambda container lives for hours.
    dbUrlPromise.catch(() => { dbUrlPromise = null; });
  }

  return dbUrlPromise;
}

let razorpayPromise = null;

export function razorpayCredentials() {
  if (!env.RAZORPAY_SECRET_ARN) {
    return Promise.reject(new Error('RAZORPAY_SECRET_ARN is not set.'));
  }

  if (!razorpayPromise) {
    razorpayPromise = readSecret(env.RAZORPAY_SECRET_ARN);
    razorpayPromise.catch(() => { razorpayPromise = null; });
  }

  return razorpayPromise;
}
