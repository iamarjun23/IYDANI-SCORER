// Secrets Manager, with a container-lifetime cache.
//
// Every GetSecretValue is a billed API call and ~30ms of latency, and the value
// does not change between invocations of the same warm container. Caching is
// therefore not an optimisation, it is the difference between one lookup per
// container and one per request.
//
// The cache is deliberately not time-limited. A rotated secret is picked up
// when the container recycles (minutes to hours); if that ever becomes too slow
// for a rotation policy, the fix is to catch the auth error and invalidate,
// not to re-fetch on a timer that is wrong in both directions.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION_NAME || process.env.AWS_REGION || 'ap-south-1',
});

const cache = new Map();

export async function readSecret(secretId) {
  if (cache.has(secretId)) return cache.get(secretId);

  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) {
    throw new Error(`Secret ${secretId} is binary or empty — expected a JSON string.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.SecretString);
  } catch {
    throw new Error(`Secret ${secretId} is not valid JSON.`);
  }

  cache.set(secretId, parsed);
  return parsed;
}
