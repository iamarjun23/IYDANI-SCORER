// Lambda entry point. `handler` is what infra/terraform/lambda.tf names.
//
// The app is built at MODULE level, not inside the handler: module scope runs
// once per container and the handler runs once per request, so building it in
// the handler would re-register every route and re-create the logger on every
// call. The await matters too — Fastify has to finish plugin registration
// before it can serve, and awaiting inside the handler would do that work on
// the first request instead of during the cold start Lambda is already paying
// for.

import awsLambdaFastify from '@fastify/aws-lambda';
import { buildApp } from './app.js';

const app = buildApp();

// ORDER MATTERS, and getting it wrong fails at IMPORT time with "The decorator
// 'awsLambda' has been added after start!" — which in Lambda means every
// invocation errors before any of this code runs. The adapter decorates the
// instance, and Fastify refuses a decorator once ready() has resolved, so the
// proxy has to be built FIRST and the app readied after.
//
// The adapter detects the API Gateway payload version (v1 REST vs v2 HTTP API)
// from the event itself, so nothing here names it — apigateway.tf pins
// payload_format_version to 2.0 and this reads whatever arrives.
const proxy = awsLambdaFastify(app);

// Plugin registration finished during the cold start Lambda is already paying
// for, rather than on the first request.
await app.ready();

export const handler = proxy;
