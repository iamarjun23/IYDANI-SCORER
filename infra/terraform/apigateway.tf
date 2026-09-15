# HTTP API (v2) rather than REST API (v1): a third of the price per request,
# and none of what v1 charges for — request validators, usage plans, API keys —
# is used here.

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  # The renderer is a page loaded from file://, which sends `Origin: null`. No
  # explicit origin string matches that, so "*" is the only value that works —
  # and it costs nothing, because CORS is a browser policy about which PAGE may
  # read a response, not an access control. Every route that matters is behind
  # the JWT authorizer below, and allow_credentials stays false so no cookie or
  # ambient credential can ride along.
  cors_configuration {
    allow_origins     = ["*"]
    allow_methods     = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers     = ["authorization", "content-type", "x-razorpay-signature"]
    expose_headers    = ["content-type"]
    allow_credentials = false
    max_age           = 3600
  }
}

# Cognito's JWTs are verified by API Gateway before the Lambda is ever invoked,
# so an unauthenticated request costs nothing and never reaches application
# code. The backend verifies them AGAIN (backend/src/auth/verify.ts) rather than
# trusting the gateway blindly — cheap, and it keeps the API runnable locally
# where no gateway exists.
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-cognito"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.desktop.id]
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

# Everything is authenticated by default. The two exceptions below are routes
# that CANNOT carry a user's token, and each is stated explicitly rather than
# left to a prefix rule — an accidentally public route is not something to
# discover from traffic.
resource "aws_apigatewayv2_route" "default" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# Razorpay signs its webhooks with an HMAC we verify in the handler; it has no
# Cognito token to present and never will.
resource "aws_apigatewayv2_route" "webhook" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /billing/webhook"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /health"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn

    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      errorMessage   = "$context.error.message"
    })
  }

  default_route_settings {
    # A desktop client that gets into a retry loop should hit a wall here, not
    # in the billing console. Raise it when there is traffic to justify it.
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${local.name_prefix}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
