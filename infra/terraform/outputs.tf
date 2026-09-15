# These four values are what the desktop app needs. After `terraform apply`,
# run `terraform output -json app_config` and paste the result into
# src/renderer/aws-config.js — see the comment at the top of that file.

output "app_config" {
  description = "Public configuration for the desktop renderer. None of this is secret."

  value = {
    region           = var.region
    userPoolId       = aws_cognito_user_pool.main.id
    userPoolClientId = aws_cognito_user_pool_client.desktop.id
    apiUrl           = aws_apigatewayv2_stage.main.invoke_url
    scoresBucketHost = "${aws_s3_bucket.scores.id}.s3.${var.region}.amazonaws.com"
  }
}

output "db_secret_arn" {
  description = "Secrets Manager ARN holding the Postgres URL — null unless use_secrets_manager is on. In the default free-tier dev path there is no secret; use db_url_dev instead."
  value       = var.use_secrets_manager ? aws_secretsmanager_secret.db[0].arn : null
}

output "razorpay_secret_name" {
  description = "Populate this by hand — see the note in secrets.tf. Null unless use_secrets_manager is on."
  value       = var.use_secrets_manager ? aws_secretsmanager_secret.razorpay[0].name : null
}

output "db_url_dev" {
  description = "The Postgres connection URL directly, for the free-tier dev path (use_secrets_manager = false). Sensitive — this is the one output that actually is a credential; do not paste it anywhere but a local .env. `npm run migrate` in backend/ reads DATABASE_URL from the environment, so: $env:DATABASE_URL = (terraform output -raw db_url_dev)"
  value       = var.use_secrets_manager ? null : local.db_url
  sensitive   = true
}

output "db_endpoint" {
  description = "Postgres host:port. Needed for `prisma migrate deploy` from a machine inside db_allowed_cidrs."
  value       = aws_db_instance.main.endpoint
}
