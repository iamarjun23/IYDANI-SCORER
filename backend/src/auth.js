// Who is making this request.
//
// API Gateway already verified the JWT before the Lambda was invoked (the JWT
// authorizer in infra/terraform/apigateway.tf), so this is the second check of
// the same signature. That is on purpose, and cheap — the verifier caches the
// JWKS for the life of the container, so it is a local signature check after
// the first call. What it buys:
//
//   - the API is runnable locally, where no gateway exists to check anything;
//   - a route added without an authorizer, or an authorizer misconfigured in
//     Terraform, fails closed here rather than silently trusting a header;
//   - and the claims are needed in application code regardless, so parsing them
//     ourselves is not extra work.
//
// The ACCESS token is verified, not the id token. The id token carries the
// profile (email, name) and is what a client is tempted to send, but it is
// issued for the client rather than for an API and Cognito's own guidance is to
// authorise with the access token. `sub` is on both and is the only claim we
// join on.

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config.js';
import { queryOne } from './db.js';

let verifier = null;

function getVerifier() {
  if (!verifier) {
    if (!config.cognito.userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID is not set — no token can be verified.');
    }

    verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: 'access',
      clientId: config.cognito.clientId || null,
    });
  }

  return verifier;
}

function bearerFrom(request) {
  const header = request.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

// Fastify preHandler. Attaches request.user (the row from `users`) and
// request.claims (what Cognito asserted). A request that gets past this has a
// verified token AND a row — see the 409 below for why those are separate.
export async function requireUser(request, reply) {
  const token = bearerFrom(request);

  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token.' });
  }

  let claims;
  try {
    claims = await getVerifier().verify(token);
  } catch (err) {
    // Expired, wrong pool, wrong client, bad signature — all one answer to the
    // caller. Which of them it was goes in the log, not in the response.
    request.log.info({ err: err.message }, 'token rejected');
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token.' });
  }

  const user = await queryOne(
    `select id, cognito_sub, email, display_name, avatar_url, bio, role,
            timezone, geo_region, onboarded_at, razorpay_customer_id,
            created_at, updated_at
       from users
      where cognito_sub = $1
        and deleted_at is null`,
    [claims.sub]
  );

  if (!user) {
    // A verified token with no row means the post-confirmation trigger did not
    // run or has not finished. It is NOT an authentication failure and must not
    // be reported as one, or the client will throw away a perfectly good
    // session and send the person back to the login screen for a condition
    // that resolves itself. 409 tells the client to retry, and /me/bootstrap
    // exists to repair it outright.
    return reply.code(409).send({
      error: 'account_not_provisioned',
      message: 'Your account exists but its profile has not been created yet.',
    });
  }

  request.user = user;
  request.claims = claims;
}

// Same, but the token is enough — no row required. Used by /me/bootstrap, which
// is the one endpoint whose entire job is to create the missing row.
export async function requireToken(request, reply) {
  const token = bearerFrom(request);

  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token.' });
  }

  try {
    request.claims = await getVerifier().verify(token);
  } catch (err) {
    request.log.info({ err: err.message }, 'token rejected');
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token.' });
  }
}

// Role gate. Returns a preHandler rather than being one, so a route reads
// `preHandler: [requireUser, requireRole('TEACHER')]` — and the order is not
// optional, since this reads the user the first one attached.
export function requireRole(...roles) {
  return async function checkRole(request, reply) {
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: `This action requires one of: ${roles.join(', ')}.`,
      });
    }
  };
}
