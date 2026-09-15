# The two functions.
#
# Both zips are built by `npm run package` in backend/ and are NOT in git. A
# plan run before that build would otherwise fail on a missing file, which reads
# as a Terraform error when it is really a "you have not built yet" — hence
# try(). Apply still fails, correctly, because Lambda cannot be created without
# a package.

locals {
  api_zip_exists              = fileexists(var.lambda_zip_path)
  post_confirmation_zip_exists = fileexists(var.post_confirmation_zip_path)

  # The free-tier dev path (default): the DB URL as a plain Lambda env var.
  # Visible to anyone with console/API read access to the function — accepted
  # for a database holding test data, not once real people's data is in it
  # (see the long comment on var.use_secrets_manager).
  db_or_secret_env = var.use_secrets_manager ? {
    DB_SECRET_ARN = aws_secretsmanager_secret.db[0].arn
  } : {
    DATABASE_URL = local.db_url
  }

  # Razorpay is not wired into any handler yet (that is Phase 3) — this exists
  # now so turning the switch on later needs no lambda.tf change, only
  # `terraform apply -var use_secrets_manager=true` plus the manual
  # put-secret-value in secrets.tf's comment.
  razorpay_env = var.use_secrets_manager ? {
    RAZORPAY_SECRET_ARN = aws_secretsmanager_secret.razorpay[0].arn
  } : {}
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "post_confirmation" {
  name              = "/aws/lambda/${local.name_prefix}-post-confirmation"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.api.arn

  filename         = var.lambda_zip_path
  source_code_hash = try(filebase64sha256(var.lambda_zip_path), null)

  runtime = "nodejs20.x"
  handler = "api.handler"

  # 512 MB is not about memory — Lambda scales CPU with it, and Prisma's client
  # start-up is CPU-bound, so a smaller setting makes cold starts slower without
  # making them cheaper (billing is GB-seconds: half the memory for twice the
  # time costs the same).
  memory_size = 512
  timeout     = 30

  environment {
    # merge() so the two paths in db_or_secret_env below can each contribute
    # only the variable that applies — DATABASE_URL in the free-tier dev path,
    # DB_SECRET_ARN once use_secrets_manager is on. backend/src/config.js
    # already checks DATABASE_URL first and falls back to DB_SECRET_ARN, so no
    # backend code branches on this switch — only Terraform does.
    variables = merge(local.db_or_secret_env, local.razorpay_env, {
      NODE_ENV             = var.environment
      SCORES_BUCKET        = aws_s3_bucket.scores.id
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.desktop.id
      AWS_REGION_NAME      = var.region
      PLATFORM_FEE_PERCENT = tostring(var.platform_fee_percent)
    })
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function" "post_confirmation" {
  function_name = "${local.name_prefix}-post-confirmation"
  role          = aws_iam_role.post_confirmation.arn

  filename         = var.post_confirmation_zip_path
  source_code_hash = try(filebase64sha256(var.post_confirmation_zip_path), null)

  runtime = "nodejs20.x"
  handler = "post-confirmation.handler"

  memory_size = 256
  timeout     = 15

  environment {
    variables = merge(local.db_or_secret_env, {
      NODE_ENV        = var.environment
      AWS_REGION_NAME = var.region
    })
  }

  depends_on = [aws_cloudwatch_log_group.post_confirmation]
}
