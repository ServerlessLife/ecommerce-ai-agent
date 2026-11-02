/**
 * The one Titan Embeddings call both sides share: the seed embeds product
 * documents, the `search_products` tool embeds the user's question — same
 * model, same 1024-dim normalized vector space.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});

async function embedText(text: string, modelId: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: 1024,
        normalize: true,
      }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: number[];
  };
  if (!Array.isArray(body.embedding)) {
    throw new Error(`Bedrock returned no embedding for "${text.slice(0, 60)}"`);
  }
  return body.embedding;
}

export const EmbeddingService = {
  embedText,
} as const;
