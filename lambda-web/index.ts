/**
 * The Lambda Web Function variant: the SAME express app as the AgentCore
 * transport, listening on the `AWS_LAMBDA_HTTP_ENDPOINT` address — no
 * handler, no event adapter. The endpoint is `ApplicationManaged` (Lambda
 * forwards the caller's `Authorization` header untouched), so an express
 * middleware validates the JWT itself.
 */
import { addCapabilities, addPing, addStrandsExpressEndpoint } from '@ag-ui/aws-strands/server';
import { AuthService } from '@sample/services';
import { AgentService } from '@sample/strands-agent/agent-service';
import type { Agent } from '@strands-agents/sdk';
import cors from 'cors';
import express from 'express';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' })); // ample for AG-UI chat invocations

/**
 * Per-thread agent cache, passed to the adapter as its `agentsByThread` map.
 * The middleware below deletes a thread's agent when the response for that
 * thread closes. Each request therefore starts with a fresh agent that
 * restores the conversation from S3 — the event Lambda's stateless behavior —
 * and the map on a warm container never grows unboundedly.
 */
const agentsByThread = new Map<string, Agent>();

// The thread id is the AG-UI input's `threadId` (parsed by express.json).
// `close` rather than `finish`: it also fires on a mid-stream client disconnect.
app.use((req, res, next) => {
  res.on('close', () => {
    const threadId = (req.body as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId === 'string') agentsByThread.delete(threadId);
  });
  next();
});

// Auth: tokens are the gate (the endpoint itself is open).
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : undefined;
  const verification = token
    ? await AuthService.verifyJwt(token, {
        jwksUrl: process.env.AUTH_JWKS_URL!,
        audience: process.env.AUTH_CLIENT_ID!,
      })
    : { valid: false as const, reason: 'missing bearer token' };
  if (!verification.valid) {
    res.status(401).json({ error: 'unauthorized', reason: verification.reason });
    return;
  }
  next();
});

const agent = AgentService.createChatAgent({ agentsByThread });
addPing(app, '/ping');
addCapabilities(app, '/capabilities', { agent });
addStrandsExpressEndpoint(app, agent, { path: '/invocations' });

// Lambda sets AWS_LAMBDA_HTTP_ENDPOINT to the listen address; the fallback is for local runs.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000').split(':');
app.listen(Number(port), host, () =>
  console.log(
    `sample agent listening on ${host}:${port} — MODEL_ID=${process.env.MODEL_ID ?? '<unset>'}`,
  ),
);
