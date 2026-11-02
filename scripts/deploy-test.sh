#!/usr/bin/env bash
# Full cost-test environment rollout, ONE command from the repo root:
#   npm run deploy:test -- test1
# Steps: deploy the environment's stacks → seed its (empty) products table →
# re-tag the AgentCore DEFAULT endpoints (they never inherit tags).
# See price-perfomance-test/README.md.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy-test.sh <environment> (e.g. test1)}"
if [[ ! "$ENVIRONMENT" =~ ^[a-z0-9]+$ ]]; then
  echo "environment must be a lowercase [a-z0-9] string, got \"$ENVIRONMENT\"" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "── 1/3 deploy (environment=$ENVIRONMENT)"
(
  cd infra
  AWS_REGION=eu-west-1 npx cdk deploy --all -c "environment=$ENVIRONMENT" \
    --require-approval never --outputs-file "cdk-outputs-$ENVIRONMENT.json"
)

echo "── 2/3 seed products table"
AWS_REGION=eu-west-1 npx tsx scripts/seed.ts --environment "$ENVIRONMENT"

echo "── 3/3 re-tag AgentCore DEFAULT endpoints"
npx tsx price-perfomance-test/tag-endpoints.ts --test "$ENVIRONMENT"

echo "✅ rollout complete for \"$ENVIRONMENT\""
