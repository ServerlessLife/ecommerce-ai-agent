/**
 * Re-tags the AgentCore DEFAULT endpoint with the `cost-experiment` billing tag.
 *
 * The service-created DEFAULT endpoint child never inherits the runtime's
 * tags, yet usage records attribute to it — without this step the AgentCore
 * spend is invisible to the tag-filtered Cost Explorer query (bill.ts).
 * One command after every AgentCore deploy (both runtimes, V1 + V2).
 *
 * Uso: npx tsx price-perfomance-test/tag-endpoints.ts --test test1
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readOutput, stackNameFor } from './agent.js';

const REGION = 'eu-west-1';

const TEST = (() => {
  try {
    const { values } = parseArgs({ options: { test: { type: 'string' } } });
    if (values.test && /^[a-z0-9]+$/.test(values.test)) return values.test;
  } catch {
    /* falls through to the usage line */
  }
  console.log(
    'Uso: npx tsx price-perfomance-test/tag-endpoints.ts --test <environment>  (e.g. test1)',
  );
  process.exit(1);
})();

const aws = (args: string[]): unknown => {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf-8',
  });
  return out.trim() ? JSON.parse(out) : {};
};

for (const platform of ['agentcorev1', 'agentcorev2'] as const) {
  const stack = stackNameFor(TEST, platform);
  const runtimeId = readOutput(TEST, stack, 'AgentCoreRuntimeId');
  const tagValue = readOutput(TEST, stack, 'CostTag'); // <test>-agentcorev1|agentcorev2 — set by the stack itself

  const { runtimeEndpoints = [] } = aws([
    'bedrock-agentcore-control',
    'list-agent-runtime-endpoints',
    '--agent-runtime-id',
    runtimeId,
  ]) as { runtimeEndpoints?: { name?: string; agentRuntimeEndpointArn?: string }[] };
  const def = runtimeEndpoints.find((e) => e.name === 'DEFAULT');
  if (!def?.agentRuntimeEndpointArn) {
    throw new Error(`${stack}: no DEFAULT endpoint found for runtime ${runtimeId}`);
  }
  aws([
    'bedrock-agentcore-control',
    'tag-resource',
    '--resource-arn',
    def.agentRuntimeEndpointArn,
    '--tags',
    JSON.stringify({ 'cost-experiment': tagValue }),
  ]);
  console.log(`${stack}: DEFAULT endpoint -> cost-experiment=${tagValue}`);
}
