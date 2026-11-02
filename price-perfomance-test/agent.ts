/**
 * Shared client for the cost-test scripts (send.ts) — the minimum needed to
 * talk to a deployed per-test stack: stack outputs, an auth token, and one
 * AG-UI turn with latency milestones.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Per-turn HTTP timeout — a streaming agent turn can be slow. */
const TURN_TIMEOUT_MS = 180_000;

export const PLATFORMS = ['lambdaevent', 'lambdaweb', 'agentcorev1', 'agentcorev2'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The per-test CDK stack that owns a platform's deployment — the SAME demo
 * stacks under the environment-prefixed name (`-c environment=test1` →
 * `Test1SampleAgentLambdaWebStack` …). */
export function stackNameFor(test: string, platform: string): string {
  const cap = test.charAt(0).toUpperCase() + test.slice(1);
  const mapa: Record<string, string> = {
    lambdaevent: `${cap}SampleAgentLambdaEventStack`,
    lambdaweb: `${cap}SampleAgentLambdaWebStack`,
    agentcorev1: `${cap}SampleAgentCoreStack`,
    agentcorev2: `${cap}SampleAgentCoreV2Stack`,
  };
  if (!mapa[platform])
    throw new Error(`Plataforma desconhecida: ${platform} (use ${PLATFORMS.join('|')})`);
  return mapa[platform];
}

/** The per-test SHARED stack (`-c environment=test1` → `Test1SampleSharedStack`)
 * — every environment deploys its own tables + auth leg. */
export function sharedStackNameFor(test: string): string {
  const cap = test.charAt(0).toUpperCase() + test.slice(1);
  return `${cap}SampleSharedStack`;
}

type StackOutputs = Record<string, Record<string, string>>;

/** The environment's OWN outputs file (`infra/cdk-outputs-<test>.json` — the
 * deploy writes one per environment so multiple coexisting environments never
 * clobber each other; the DEMO deploy without `-c environment=` keeps writing
 * the plain `infra/cdk-outputs.json`). */
export function outputsFileFor(test: string): string {
  if (!/^[a-z0-9]+$/.test(test))
    throw new Error(`--test must be a lowercase [a-z0-9] label, got "${test}".`);
  return path.resolve(import.meta.dirname, '..', 'infra', `cdk-outputs-${test}.json`);
}

function outputs(test: string): StackOutputs {
  const file = outputsFileFor(test);
  if (!existsSync(file)) {
    throw new Error(
      `Missing ${file} — deploy the "${test}" environment first (npm run deploy:test -- ${test}).`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as StackOutputs;
}

/** One stack output value (trimmed) from the test environment's outputs file. */
export function readOutput(test: string, stack: string, key: string): string {
  const value = outputs(test)[stack]?.[key];
  if (!value) {
    throw new Error(
      `Missing ${stack}.${key} in infra/cdk-outputs-${test}.json — deploy the ${stack} stack first (npm run deploy:test -- ${test}).`,
    );
  }
  return value.trim();
}

/** The agent invoke URL of a deployed per-test stack. */
export function agentUrl(test: string, platform: string): string {
  const stack = stackNameFor(test, platform);
  if (platform === 'lambdaweb') {
    return `${readOutput(test, stack, 'AgentLambdaWebUrl').replace(/\/+$/, '')}/invocations`;
  }
  if (platform === 'lambdaevent') {
    return readOutput(test, stack, 'AgentLambdaEventUrl');
  }
  return `${readOutput(test, stack, 'AgentCoreRuntimeUrl').replace(/\/+$/, '')}/invocations`;
}

/** A fresh toy-JWT token (TTL 1 h — send.ts mints one per batch, outside the
 * requests' timed window) from the TEST's own shared stack auth leg. */
export async function fetchToken(test: string): Promise<string> {
  const base = readOutput(test, sharedStackNameFor(test), 'AuthBaseUrl').replace(/\/+$/, '');
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'sample-chat', subject: 'load-test' }),
  });
  if (!res.ok) throw new Error(`POST ${base}/token → HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('/token returned no access_token');
  return body.access_token;
}
export type InvokeResult = {
  status: number;
  ok: boolean;
  ttfbMs: number;
  firstCharMs: number | null;
  wallMs: number;
  toolCalls: number;
  chars: number;
  error: string;
  /** Every raw SSE `data:` payload the run streamed, in arrival order. */
  events: string[];
  /** The assembled answer — all TEXT_MESSAGE_CONTENT deltas concatenated. */
  text: string;
};

type AgUiEvent = { type: string; delta?: string; message?: string };

/**
 * The two client tools the widget executes in the browser (`widget/src/main.tsx`
 * `BasketTools`) — declared on EVERY run, exactly like CopilotKit does via
 * `input.tools`: the adapter auto-registers a matching proxy tool per declared
 * name, and a call to one parks the run for the client to answer.
 *
 * Declaring them is NOT optional for the load test: the system prompt names
 * `add_to_cart`/`get_cart_content`, so the model calls them even when the
 * request declares no tools — and an undeclared call resolves to Strands'
 * ToolNotFoundError (`Tool 'add_to_cart' not found`), which the adapter then
 * unconditionally JSON.parses → the `tool result JSON parse failed ... using
 * raw text` warning in the runtime logs (observed live in the agentcorev2
 * proba run, session 20261021-082433-5). The schemas/descriptions mirror the
 * widget's constants — keep the two in sync.
 */
const ADD_TO_CART_PARAMETERS = {
  type: 'object',
  properties: {
    productId: {
      type: 'string',
      description: "The product's id — the `id` field of the matching `search_products` result.",
    },
    title: {
      type: 'string',
      description: 'The product title, exactly as the `search_products` result named it.',
    },
    quantity: {
      type: 'integer',
      description: 'How many units to add. Defaults to 1.',
    },
  },
  required: ['productId', 'title'],
} as const;

const CLIENT_TOOLS = [
  {
    name: 'add_to_cart',
    description:
      'Add a product to the shopping basket. Runs in the user’s browser; ' +
      'look up the product with `search_products` first and pass its `id` and `title`.',
    parameters: ADD_TO_CART_PARAMETERS,
  },
  {
    name: 'get_cart_content',
    description:
      'Return the basket’s current contents, as the user’s browser holds them. ' +
      'Answer every question about the basket from this result only.',
    parameters: { type: 'object', properties: {} },
  },
] as const;

/**
 * One AG-UI turn's request body — built here so invoke() sends and send.ts
 * logs the EXACT same object (the runId/message ids are minted once, in the
 * caller, before the request fires).
 */
export function turnBody(sessionId: string, message: string): Record<string, unknown> {
  return {
    threadId: sessionId,
    runId: `run-${crypto.randomUUID()}`,
    tools: CLIENT_TOOLS,
    context: [],
    state: {},
    forwardedProps: {},
    messages: [{ id: `u-${crypto.randomUUID()}`, role: 'user', content: message }],
  };
}

/** POST one AG-UI turn and stream it — ttfb = first response byte,
 * firstChar = first visible answer character, wall = the whole response.
 * `body` comes from turnBody() so the caller can log what was sent. */
export async function invoke(
  url: string,
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<InvokeResult> {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const result: InvokeResult = {
    status: res.status,
    ok: false,
    ttfbMs: -1,
    firstCharMs: null,
    wallMs: 0,
    toolCalls: 0,
    chars: 0,
    error: '',
    events: [],
    text: '',
  };
  if (!res.body) {
    result.error = `HTTP ${res.status} with no response body`;
    result.wallMs = Date.now() - started;
    return result;
  }

  let buffer = '';
  const consume = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let event: AgUiEvent;
      try {
        event = JSON.parse(payload) as AgUiEvent;
      } catch {
        continue;
      }
      if (event.type === 'RUN_FINISHED') result.ok = true;
      if (event.type === 'RUN_ERROR') result.error = event.message ?? 'RUN_ERROR (sem mensagem)';
      if (event.type === 'TOOL_CALL_START') result.toolCalls += 1;
      if (event.type === 'TEXT_MESSAGE_CONTENT' && event.delta !== undefined) {
        if (result.firstCharMs === null) result.firstCharMs = Date.now() - started;
        result.chars += event.delta.length;
        result.text += event.delta;
      }
      result.events.push(payload);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (result.ttfbMs === -1) result.ttfbMs = Date.now() - started;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) consume(frame);
  }
  if (buffer.trim() !== '') consume(buffer);
  if (result.ttfbMs === -1) result.ttfbMs = Date.now() - started;
  result.wallMs = Date.now() - started;
  if (res.status >= 400 && !result.error) result.error = `HTTP ${res.status}`;
  return result;
}
