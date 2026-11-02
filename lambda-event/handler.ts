/**
 * The Lambda Event Function: the handler IS the transport — a Function URL
 * with auth NONE and native response streaming. It verifies the bearer JWT,
 * decodes the AG-UI `RunAgentInput`, and streams SSE-encoded `agent.run`
 * events. The agent wrapper is rebuilt per invocation (a process-cached
 * per-thread cache would grow unboundedly and go stale); the fresh agent
 * restores the conversation from S3.
 */
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';
import { AuthService } from '@sample/services';
import { AgentService } from '@sample/strands-agent/agent-service';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/** Minimal decode of the AG-UI input — only the fields the agent needs. */
function parseRunAgentInput(raw: string): RunAgentInput {
  const parsed = JSON.parse(raw) as Partial<RunAgentInput>;
  if (
    typeof parsed.threadId !== 'string' ||
    typeof parsed.runId !== 'string' ||
    !Array.isArray(parsed.messages)
  ) {
    throw new Error('RunAgentInput requires threadId, runId and messages');
  }
  return parsed as RunAgentInput;
}

function bearerToken(event: APIGatewayProxyEventV2): string | undefined {
  const authorization = event.headers?.authorization ?? event.headers?.Authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

async function handle(
  event: APIGatewayProxyEventV2,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  // Streaming responses must set status + headers BEFORE anything is written.
  const writeJson = (statusCode: number, body: unknown): void => {
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { 'content-type': 'application/json' },
    });
    out.write(JSON.stringify(body));
    out.end();
  };

  // Auth: tokens are the gate (the Function URL itself has auth NONE).
  const token = bearerToken(event);
  const verification = token
    ? await AuthService.verifyJwt(token, {
        jwksUrl: process.env.AUTH_JWKS_URL!,
        audience: process.env.AUTH_CLIENT_ID!,
      })
    : { valid: false as const, reason: 'missing bearer token' };
  if (!verification.valid) {
    return writeJson(401, { error: 'unauthorized', reason: verification.reason });
  }

  // ── Decode the AG-UI input. ──
  let input: RunAgentInput;
  try {
    input = parseRunAgentInput(event.body ?? '');
  } catch (error) {
    return writeJson(400, { error: 'invalid RunAgentInput', detail: String(error) });
  }

  // Build the agent for THIS invocation (see the file docs).
  const agent = AgentService.createChatAgent();

  // Stream the AG-UI events.
  const encoder = new EventEncoder();
  const streaming = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'content-type': encoder.getContentType() },
  });
  try {
    for await (const agUiEvent of agent.run(input)) {
      streaming.write(encoder.encode(agUiEvent));
    }
  } catch (error) {
    // The run lifecycle must terminate — surface the failure as RUN_ERROR.
    console.error('agent run failed:', error);
    streaming.write(
      encoder.encode({
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    streaming.end();
  }
}

export const handler = awslambda.streamifyResponse(handle);
