/**
 * download-logs.ts — downloads the test's CloudWatch logs into
 * results/<test>/<platform>/logs/<group>.jsonl (one JSON line per event:
 * {"timestamp": ms, "stream": "...", "message": "..."}).
 * Groups: read from the stack's CloudFormation outputs (infra/cdk-outputs-<test>.json).
 * Usage: npx tsx price-perfomance-test/download-logs.ts --test test1 --platform lambdaweb
 *   [--from <iso-date|epoch-ms>]   only download events at/after this instant
 *                                  (default: the whole log group)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { readOutput, stackNameFor } from './agent.js';

const cw = new CloudWatchLogsClient({ region: 'eu-west-1' });

/** Lower bound for downloaded events (epoch ms) — set from --from, default 0 (all). */
let startTime = 0;

/** Log groups to download for this platform, from the stack's outputs. AgentCore has two. */
function groupsFor(platform: string, test: string): string[] {
  const stack = stackNameFor(test, platform);
  if (platform === 'lambdaevent') return [readOutput(test, stack, 'AgentLambdaEventLogGroup')];
  if (platform === 'lambdaweb') return [readOutput(test, stack, 'AgentLambdaWebLogGroup')];
  const runtimeId = readOutput(test, stack, 'AgentCoreRuntimeId');
  return [
    readOutput(test, stack, 'AgentCoreUsageLogGroup'),
    `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`,
  ];
}

/** Log group name -> file name ("aws/lambda_Foo" for "/aws/lambda/Foo"). */
const slug = (group: string): string => group.replace(/^\//, '').replace(/[/]/g, '_');

/** Download ALL events of a group (paged) into <dir>/<slug>.jsonl. */
async function download(group: string, dir: string): Promise<void> {
  console.log(`Downloading ${group}`);
  const events: string[] = [];
  let next: string | undefined;
  // FilterLogEvents returns at most 1 MB per call; page until the token runs out.
  do {
    const res = await cw.send(
      new FilterLogEventsCommand({ logGroupName: group, startTime, nextToken: next }),
    );
    for (const e of res.events ?? []) {
      if (e.timestamp === undefined || e.message === undefined) continue;
      events.push(
        JSON.stringify({
          timestamp: e.timestamp,
          stream: e.logStreamName ?? '',
          message: e.message,
        }),
      );
    }
    next = res.nextToken;
  } while (next);
  // Empty file (not an error) if the group had no events — CSV tooling still works.
  const dest = path.join(dir, `${slug(group)}.jsonl`);
  writeFileSync(dest, events.length ? `${events.join('\n')}\n` : '');
  console.log(`  ${events.length} events -> ${path.basename(dest)}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'string' },
      platform: { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npx tsx price-perfomance-test/download-logs.ts --test test1 --platform lambdaweb [--from <iso-date|epoch-ms>]',
    );
    return;
  }
  const { test, platform } = values;
  if (!test || !platform) {
    throw new Error(
      'Usage: npx tsx price-perfomance-test/download-logs.ts --test test1 --platform lambdaweb [--from <iso-date|epoch-ms>]',
    );
  }
  // Optional lower bound: epoch milliseconds or any Date.parse-able ISO string.
  startTime = 0;
  if (values.from !== undefined && values.from.trim() !== '') {
    const n = Number(values.from);
    startTime = Number.isFinite(n) ? n : Date.parse(values.from);
    if (!Number.isFinite(startTime))
      throw new Error(`--from must be epoch milliseconds or an ISO date (got "${values.from}")`);
    console.log(`Downloading events from ${new Date(startTime).toISOString()}`);
  }
  const dir = path.resolve(import.meta.dirname, 'results', test, platform, 'logs');
  mkdirSync(dir, { recursive: true });
  await Promise.all(groupsFor(platform, test).map((group) => download(group, dir)));
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
