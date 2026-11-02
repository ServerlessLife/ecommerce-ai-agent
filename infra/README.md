# AWS CDK infrastructure

This directory contains the AWS CDK application for the [e-commerce AI agent sample](../README.md). It deploys the same Strands agent to four runtimes, together with the product catalog, conversation storage, demo authentication, and browser widget.

The CDK entry point is [`bin/infra.ts`](bin/infra.ts). Shared values, including model IDs and vector-index settings, are defined in [`lib/Config.ts`](lib/Config.ts).

## Stacks

- [`SharedStack.ts`](lib/SharedStack.ts) — DynamoDB products table and vector index, S3 conversation bucket, and KMS-backed demo JWT issuer.
- [`AgentLambdaEventStack.ts`](lib/AgentLambdaEventStack.ts) — Lambda Event Function with a streaming Function URL.
- [`AgentLambdaWebStack.ts`](lib/AgentLambdaWebStack.ts) — Lambda Web Function, deployed as a packaged Express server using CloudFormation Web Function resources.
- [`AgentCoreStack.ts`](lib/AgentCoreStack.ts) — AgentCore Runtime, instantiated separately for V1 and V2.
- [`WidgetStack.ts`](lib/WidgetStack.ts) — public S3 website hosting the demo widget and a generated `config.js` listing the runtime endpoints and authentication URL.

The runtime stacks import shared resource names and URLs through CloudFormation exports. All four use the agent in [`../strands-agent/AgentService.ts`](../strands-agent/AgentService.ts); transport and hosting differ, not the agent's business logic.

## Deploy the demo

From the repository root:

```bash
npm install
npm run login
npm run deploy
npm run seed
```

The root deployment script packages the AgentCore and Lambda Web applications, builds the widget, and runs CDK deployment. The infrastructure package deploys to `eu-west-1` and writes `infra/cdk-outputs.json`. The seed script uses those outputs to import DummyJSON products, create Titan embeddings, and populate the DynamoDB table.

The `WidgetUrl` output points to the demo page. Its backend selector switches among AgentCore V1, AgentCore V2, Lambda Event Function, and Lambda Web Function.

**The deployment creates billable AWS resources.** Authentication and the basket are demonstrations, not production-ready integrations. After testing, destroy the demo stacks from this directory:

```bash
npx cdk destroy --all
```

Review the resources and removal policies before running the destroy command: the sample configures deletion of demo product data and stored conversations.

## Isolated cost-test environments

The same CDK app supports an optional `-c environment=test1` context. This creates prefixed stacks and separate data and authentication resources, tags the runtime resources for cost attribution, and skips the demo widget. For example, `test1` creates `Test1SampleSharedStack`, `Test1SampleAgentCoreStack`, `Test1SampleAgentCoreV2Stack`, `Test1SampleAgentLambdaEventStack`, and `Test1SampleAgentLambdaWebStack`.

From the repository root, use the test deployment script to deploy, seed, and tag the AgentCore endpoints:

```bash
npm run deploy:test -- test1
```

For manual CDK deployment from this directory, first build the runtime artifacts from the repository root (`npm run package`). Then deploy with the environment context:

```bash
AWS_REGION=eu-west-1 npx cdk deploy --all -c environment=test1 \
  --require-approval never --outputs-file cdk-outputs-test1.json
```

A manual test deployment also needs product seeding using `scripts/seed.ts --environment test1` and tagging of the service-created AgentCore default endpoints using `price-perfomance-test/tag-endpoints.ts --test test1`. The test deployment script handles these steps.

To remove this test environment without deleting the regular demo stacks:

```bash
AWS_REGION=eu-west-1 npx cdk destroy 'Test1*' -c environment=test1 --require-approval never
```

See the [cost-test runbook](../price-perfomance-test/README.md) for the full sequence and [experiment design](../docs/plan/cost-tests-plan.md) for methodology.
