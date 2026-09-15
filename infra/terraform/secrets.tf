# Secrets Manager. GATED behind var.use_secrets_manager (default false) — see
# the long comment on that variable in variables.tf for why: it is the one
# service here with no Free Tier at all, so a dev/test stack skips it entirely
# and the Lambda gets its DB URL as a plain environment variable instead
# (lambda.tf). Flip the variable to true before this ever holds a real user's
# data — the count = ... 0-or-1 pattern below is what makes that a one-line
# change rather than a rewrite: every resource here either exists once or not
# at all, so `terraform apply -var use_secrets_manager=true` creates them
# without touching anything else in the stack.

resource "aws_secretsmanager_secret" "db" {
  count = var.use_secrets_manager ? 1 : 0

  name                    = "${local.name_prefix}/db"
  description             = "Postgres connection URL for the IYDANI API"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "db" {
  count = var.use_secrets_manager ? 1 : 0

  secret_id = aws_secretsmanager_secret.db[0].id

  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = aws_db_instance.main.db_name
    url      = local.db_url
  })
}

# Created EMPTY on purpose, same as before. Terraform state is a plaintext
# file; a live payment credential typed into a .tf or a tfvars is a credential
# in that file, in every state backup, and in every terminal that ever ran
# `terraform show`. The value goes in by hand, once, and only once this switch
# is on:
#
#   aws secretsmanager put-secret-value \
#     --secret-id iydani-dev/razorpay \
#     --secret-string '{"keyId":"rzp_test_...","keySecret":"...","webhookSecret":"..."}'
resource "aws_secretsmanager_secret" "razorpay" {
  count = var.use_secrets_manager ? 1 : 0

  name                    = "${local.name_prefix}/razorpay"
  description             = "Razorpay key id, key secret and webhook signing secret. Populated manually — never through Terraform."
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}
