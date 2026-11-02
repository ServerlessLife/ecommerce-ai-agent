/**
 * AgentCore Runtime HTTP transport: `GET /ping`, `GET /capabilities` and the
 * AG-UI `POST /invocations` endpoint, mounted by the `@ag-ui/aws-strands`
 * adapter around the shared agent. CORS is required for the widget's
 * cross-origin SSE stream.
 */
import { addCapabilities, addPing, addStrandsExpressEndpoint } from '@ag-ui/aws-strands/server';
import { AgentService } from '@sample/strands-agent/agent-service';
import cors from 'cors';
import express from 'express';

async function main(): Promise<void> {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' })); // ample for AG-UI chat invocations

  const agent = AgentService.createChatAgent();

  addPing(app, '/ping');
  addCapabilities(app, '/capabilities', { agent });
  addStrandsExpressEndpoint(app, agent, { path: '/invocations' });

  // AgentCore injects PORT; 8080 keeps local dev unchanged.
  const port = process.env.PORT ? Number(process.env.PORT) : 8080;
  app.listen(port, () =>
    console.log(
      `sample agent listening on :${port} — MODEL_ID=${process.env.MODEL_ID ?? '<unset>'}`,
    ),
  );
}

main().catch((error) => {
  console.error('sample agent startup failed:', error);
  process.exit(1);
});
