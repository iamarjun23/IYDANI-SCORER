// Print the deployed database URL, for psql or for a local run against the
// real database.
//
// By default this stack has use_secrets_manager = false (the free-tier dev
// path — see variables.tf), so the URL comes straight out of a Terraform
// output rather than Secrets Manager:
//
//   cd ../infra/terraform && terraform output -raw db_url_dev
//
// This script is what to use if you have FLIPPED the switch to true, since at
// that point the URL is no longer a plain output — it exists only inside
// Secrets Manager:
//
//   DB_SECRET_ARN=$(cd ../infra/terraform && terraform output -raw db_secret_arn) //     node tools/db-url.mjs
//
// Either way it goes to stdout and nowhere else — do not paste the result into
// a file.

import { readSecret } from '../src/secrets.js';

const arn = process.env.DB_SECRET_ARN;
if (!arn) {
  console.error('Set DB_SECRET_ARN — or, if use_secrets_manager is false (the default),');
  console.error('just run: terraform output -raw db_url_dev  (from infra/terraform)');
  process.exit(1);
}

const secret = await readSecret(arn);
console.log(secret.url);
