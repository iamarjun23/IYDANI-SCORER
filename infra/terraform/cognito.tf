# Cognito owns credentials; the Postgres in rds.tf owns everything else about a
# person. That split is why the User model in backend/prisma/schema.prisma has
# no passwordHash and no mfaSecret column — docs/roadmap/AUTH-FLOW.md's bcrypt
# work factor, refresh-token family rotation and KMS-encrypted TOTP secrets are
# all things Cognito already does, and a hand-rolled second copy of them is a
# security surface with no upside.

resource "aws_cognito_user_pool" "main" {
  name = "${local.name_prefix}-users"

  # Email IS the username. A separate username field means a person can fail to
  # log in with the address they registered with, which is the single most
  # common support ticket an auth system generates.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_uppercase                = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # Cognito's own verification/reset emails. They come from a Cognito-owned
  # address and are rate-limited to 50/day, which is ample for development and
  # is the reason SES is not in this stack yet. Moving to SES later is a change
  # to this one block plus a verified domain — no application code moves.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your IYDANI verification code"
    email_message        = "Your IYDANI verification code is {####}"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  schema {
    name                     = "name"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 128
    }
  }

  # Fires once, after the user proves they own the email address. This is what
  # creates the matching row in Postgres — see backend/src/triggers/post-confirmation.ts
  # for why it is a trigger and not a call the app makes after login.
  lambda_config {
    post_confirmation = aws_lambda_function.post_confirmation.arn
  }

  deletion_protection = var.environment == "prod" ? "ACTIVE" : "INACTIVE"
}

resource "aws_cognito_user_pool_client" "desktop" {
  name         = "${local.name_prefix}-desktop"
  user_pool_id = aws_cognito_user_pool.main.id

  # NO client secret. The client here is a desktop app the user has a copy of —
  # a secret shipped inside it is not a secret, and Cognito's own guidance is to
  # use a public client for exactly this case. Everything that actually needs to
  # be trusted is enforced server-side against the JWT, never against knowing an
  # app client id.
  generate_secret = false

  # USER_PASSWORD_AUTH rather than SRP. SRP would require the ~200KB
  # amazon-cognito-identity-js bundle vendored into a renderer whose CSP forbids
  # every CDN, to compute a zero-knowledge proof over a channel that is already
  # TLS. The password reaches Cognito either way; SRP protects it from a
  # compromised TLS terminator we do not have. REFRESH_TOKEN_AUTH is what keeps
  # somebody logged in across relaunches.
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # docs/roadmap/AUTH-FLOW.md's token specs, expressed in Cognito's terms.
  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # A stolen refresh token can be used exactly once: Cognito hands back a new
  # one and invalidates the presented token. This is the managed equivalent of
  # the UserSession family rotation the roadmap describes building by hand.
  enable_token_revocation = true

  prevent_user_existence_errors = "ENABLED"

  read_attributes  = ["email", "email_verified", "name"]
  write_attributes = ["email", "name"]
}

resource "aws_lambda_permission" "cognito_post_confirmation" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
