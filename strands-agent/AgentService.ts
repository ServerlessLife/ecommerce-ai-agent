/**
 * The sample chat agent: a Strands `Agent` on a Bedrock model, wrapped in the
 * `@ag-ui/aws-strands` AG-UI adapter. One server-side tool (`search_products`,
 * core in `services/ProductService.ts`); the widget's client tools
 * (`add_to_cart` / `get_cart_content`) are declared by the widget per run.
 *
 * Memory is per thread via the adapter's `sessionManagerProvider` (S3-backed
 * session restore/save) and `threadAgentConfig` (summarizing conversation
 * manager per thread).
 */

import { StrandsAgent } from '@ag-ui/aws-strands';
import { ProductService } from '@sample/services/product-service';
import {
  Agent,
  BedrockModel,
  SessionManager,
  SummarizingConversationManager,
  tool,
} from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

const SYSTEM_PROMPT = [
  'You are the friendly assistant of a small demo online store. Answer briefly.',
  'Answer product questions from `search_products` results only — never invent products — and recommend a loose-but-real match over giving up.',
  'The user’s browser runs `add_to_cart` and `get_cart_content`: add only `search_products` results (their `id` and `title`), and answer basket questions from `get_cart_content` only.',
].join(' ');

/** The agent's single tool: the Strands wrapper around the search core. */
function searchProducts() {
  return tool({
    name: 'search_products',
    description:
      'Search the demo store catalog. Returns the most relevant products for the query, best first, each with price (USD) and stock.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The user's need or goal, as a short plain-text phrase that KEEPS the intent words " +
            '(e.g. "keep my drinks cold", not just "drinks"). ' +
            'Drop conversational filler, keep what the product must do.',
        ),
    }),
    callback: async ({ query }) => JSON.stringify(await ProductService.searchProductCatalog(query)),
  });
}

/** The chat agent factory — the adapter clones a per-thread agent from this template. */
function createChatAgent(options: { agentsByThread?: Map<string, Agent> } = {}): StrandsAgent {
  const model = new BedrockModel({
    modelId: process.env.MODEL_ID!,
    maxTokens: 1024,
    // The SDK's context-window table has no entry for gpt-oss-20b, so set the
    // real window — the conversation manager compresses against it.
    contextWindowLimit: 131_072,
  });

  // Blueprint only — the adapter clones a per-thread agent from it, and never
  // copies `sessionManager` / `conversationManager` (per-thread state). Both
  // are wired per thread in `config` below.
  const template = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [searchProducts()],
    printer: false,
  });

  return new StrandsAgent({
    agent: template,
    name: 'sample-chat',
    config: {
      replayHistoryIntoStrands: false,
      // A snapshot replaces the client's transcript and is seeded from the
      // request — with newest-message-only runs it would carry just the last
      // turn. The widget assembles its transcript from the streamed events.
      emitMessagesSnapshot: false,
      // One S3-backed session per thread: the sessionId IS the threadId.
      sessionManagerProvider: ({ threadId }) =>
        new SessionManager({
          sessionId: threadId,
          storage: new S3Storage(process.env.CONVERSATIONS_BUCKET!),
          saveLatestOn: 'invocation',
        }),
      // Not on the template — it never reaches the clones. Via the option,
      // not `plugins`: the Agent registers its manager as a plugin.
      threadAgentConfig: () => ({
        conversationManager: new SummarizingConversationManager({
          // Summarize at ~70% context occupancy — before the model call
          // fails with an overflow, not after.
          proactiveCompression: true,
        }),
      }),
    },
    ...options,
  });
}

export const AgentService = {
  createChatAgent,
} as const;
