/** Debug: replay the widget's exact flow against a deployed backend —
 * mint a JWT, POST an AG-UI RunAgentInput to /invocations, print the SSE
 * event stream (tool calls, results, assistant text).
 * Usage: npx tsx scripts/debug-replay.ts <backend: agentcore|agentcorev2|lambdaevent|lambdaweb> [query]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const outputsPath = path.resolve(import.meta.dirname, '..', 'infra', 'cdk-outputs.json');
const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<
  string,
  Record<string, string>
>;

/** Read one stack output, failing loud when the deploy predates it. */
function output(stack: string, key: string): string {
  const value = outputs[stack]?.[key];
  if (!value) {
    throw new Error(`Missing ${stack}.${key} in ${outputsPath} — redeploy (npm run deploy).`);
  }
  return value.trim();
}

const BACKEND = process.argv[2] ?? 'agentcore';
const QUERY = process.argv[3] ?? 'Which product is good for sleep?';

const URLS: Record<string, string> = {
  agentcore: output('SampleAgentCoreStack', 'AgentCoreRuntimeUrl'),
  agentcorev2: output('SampleAgentCoreV2Stack', 'AgentCoreRuntimeUrl'),
  lambdaevent: output('SampleAgentLambdaEventStack', 'AgentLambdaEventUrl'),
  lambdaweb: output('SampleAgentLambdaWebStack', 'AgentLambdaWebUrl'),
};
const agentUrl = URLS[BACKEND];
if (!agentUrl) throw new Error(`Unknown backend ${BACKEND}`);
const authUrl = output('SampleSharedStack', 'AuthBaseUrl');

// 1) Mint the JWT like the widget does.
const tokenRes = await fetch(`${authUrl.replace(/\/+$/, '')}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_id: 'sample-chat' }),
});
const tokenData = (await tokenRes.json()) as { access_token?: string };
if (!tokenRes.ok || !tokenData.access_token) {
  throw new Error(`Token mint failed: HTTP ${tokenRes.status} ${JSON.stringify(tokenData)}`);
}
console.log('JWT minted.');

// 2) One AG-UI turn.
const threadId = `debug-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const body = {
  threadId,
  runId: `run-${Date.now()}`,
  state: {},
  messages: [{ id: `msg-${Date.now()}`, role: 'user', content: QUERY }],
  tools: [],
  context: [],
  forwardedProps: {},
};
const headers: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
  authorization: `Bearer ${tokenData.access_token}`,
};
if (BACKEND.startsWith('agentcore')) {
  headers['x-amzn-bedrock-agentcore-runtime-session-id'] = threadId;
}

console.log(`POST ${agentUrl}/invocations (thread ${threadId})`);
const res = await fetch(`${agentUrl.replace(/\/+$/, '')}/invocations`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
console.log('HTTP', res.status, res.headers.get('content-type'));
if (!res.ok || !res.body) {
  console.log('Body:', await res.text());
  process.exit(1);
}

// 3) Stream the SSE events.
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let sep = buffer.indexOf('\n\n');
  while (sep !== -1) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const event = JSON.parse(dataLines.join('\n')) as { type: string; [k: string]: unknown };
    const t = event.type;
    if (t === 'TEXT_MESSAGE_START' || t === 'TEXT_MESSAGE_CONTENT') {
      const delta = (event.delta as string) ?? '';
      process.stdout.write(delta);
    } else if (t === 'TOOL_CALL_START') {
      console.log(`\n[TOOL_CALL_START] ${JSON.stringify(event)}`);
    } else if (t === 'TOOL_CALL_ARGS') {
      console.log(`[TOOL_CALL_ARGS] ${String(event.delta)}`);
    } else if (t === 'TOOL_CALL_RESULT') {
      console.log(`[TOOL_CALL_RESULT] ${String(event.content).slice(0, 600)}`);
    } else if (t === 'RUN_ERROR' || t === 'RUN_FINISHED' || t === 'RUN_STARTED') {
      console.log(`[${t}] ${JSON.stringify(event).slice(0, 500)}`);
    }
    sep = buffer.indexOf('\n\n');
  }
}
process.stdout.write('\n');
