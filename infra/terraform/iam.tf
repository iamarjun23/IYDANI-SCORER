# Lambda execution roles. Two of them, because the two functions need different
# things and a shared role would hand the Cognito trigger — which runs on
# unauthenticated signup traffic — the S3 and Razorpay access the API needs.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "post_confirmation" {
  name               = "${local.name_prefix}-post-confirmation"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "post_confirmation_logs" {
  role       = aws_iam_role.post_confirmation.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api" {
  # Objects only, and only in this bucket. The API signs URLs rather than
  # streaming bodies, but signing a URL still requires holding the permission
  # the URL grants — a presigned URL cannot confer access the signer lacks.
  statement {
    sid    = "ScoreObjects"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${aws_s3_bucket.scores.arn}/*"]
  }

  statement {
    sid       = "ListScoreBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.scores.arn]
  }

  # Granted only when var.use_secrets_manager is on. In the default free-tier
  # dev path there is no Secrets Manager secret to read — the DB URL arrives as
  # a plain env var instead (lambda.tf) — and a statement with an empty
  # `resources` list is invalid, so the whole statement is conditional rather
  # than just its resource list.
  dynamic "statement" {
    for_each = var.use_secrets_manager ? [1] : []

    content {
      sid    = "ReadSecrets"
      effect = "Allow"

      actions = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]

      resources = [
        aws_secretsmanager_secret.db[0].arn,
        aws_secretsmanager_secret.razorpay[0].arn,
      ]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.name_prefix}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# The trigger writes one row and needs the database credential to do it. Same
# conditional shape as above — nothing to grant when use_secrets_manager is
# off, since the URL is already in its environment.
data "aws_iam_policy_document" "post_confirmation" {
  dynamic "statement" {
    for_each = var.use_secrets_manager ? [1] : []

    content {
      sid    = "ReadDbSecret"
      effect = "Allow"

      actions = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]

      resources = [aws_secretsmanager_secret.db[0].arn]
    }
  }

  # A policy document with zero statements is invalid, and this one would have
  # none when the switch is off. A harmless, near-universally-available
  # read-only action keeps the document non-empty without granting anything
  # that matters — the trigger already gets CloudWatch Logs write access
  # separately (aws_iam_role_policy_attachment.post_confirmation_logs).
  statement {
    sid       = "Placeholder"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "post_confirmation" {
  name   = "${local.name_prefix}-post-confirmation"
  role   = aws_iam_role.post_confirmation.id
  policy = data.aws_iam_policy_document.post_confirmation.json
}
