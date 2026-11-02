/**
 * Semantic product search over the DynamoDB vector index: Titan-embed the
 * query, fetch cosine candidates (`SearchVectors`) — the top 50 when a
 * reranker will re-score them, else the final 5 directly — then, where the
 * deployment provides one, re-score with the Bedrock Rerank cross-encoder
 * and keep its top 5. Failures propagate; no silent fallback.
 *
 * Relevance scores stay internal — result order alone carries relevance to the
 * model. Consumed by the `search_products` tool in `strands-agent/AgentService.ts`.
 */

import { BedrockAgentRuntimeClient, RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, SearchVectorsCommand } from '@aws-sdk/lib-dynamodb';
import { EmbeddingService } from './EmbeddingService.js';

/** Cosine candidates fetched for the reranker to re-score. */
const CANDIDATES = 50;
/** Results returned to the model. */
const TOP_RESULTS = 5;
/** Rerankers score the document head — bound every document. */
const DOC_MAX_CHARS = 2000;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Rerank models are regional (see infra/lib/Config.ts) — target RERANK_REGION when set.
const bedrockAgentRuntime = new BedrockAgentRuntimeClient(
  process.env.RERANK_REGION ? { region: process.env.RERANK_REGION } : {},
);

/** One product as the search returns it. */
type Product = {
  id?: string;
  title?: string;
  description?: string;
  price?: number;
  stock?: number;
};

/** Re-score products against the query; returns the top 5, best first. */
async function rerank(query: string, modelArn: string, products: Product[]): Promise<Product[]> {
  const response = await bedrockAgentRuntime.send(
    new RerankCommand({
      queries: [{ type: 'TEXT', textQuery: { text: query } }],
      sources: products.map((product) => ({
        type: 'INLINE',
        inlineDocumentSource: {
          type: 'TEXT',
          textDocument: {
            text: `${product.title}. ${product.description}`.slice(0, DOC_MAX_CHARS),
          },
        },
      })),
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          modelConfiguration: { modelArn },
          numberOfResults: TOP_RESULTS,
        },
      },
    }),
  );
  return (response.results ?? []).map((result) => products[result.index ?? -1]);
}

/**
 * Full catalog search: Titan embed → cosine search → [rerank] → the model's
 * result list.
 */
async function searchProductCatalog(query: string): Promise<{ results: Product[] }> {
  const tableName = process.env.PRODUCTS_TABLE!;
  const indexName = process.env.VECTOR_INDEX!;
  const embedModel = process.env.EMBEDDING_MODEL_ID!;
  // Rerank is per-deployment — see infra/lib/Config.ts.
  const rerankModelArn = process.env.RERANK_MODEL_ARN;

  const queryVector = await EmbeddingService.embedText(query, embedModel);
  // COSINE distance (lower = closer); the DocumentClient marshals the plain number vector.
  const response = await dynamo.send(
    new SearchVectorsCommand({
      TableName: tableName,
      IndexName: indexName,
      SearchVector: queryVector,
      TopK: rerankModelArn ? CANDIDATES : TOP_RESULTS,
    }),
  );

  const candidates = (response.SearchResults ?? []).map((hit) => (hit.Item ?? {}) as Product);
  const usable = candidates.filter(
    (candidate) => candidate.id && candidate.title && candidate.description,
  );

  const results = rerankModelArn ? await rerank(query, rerankModelArn, usable) : usable;
  return { results };
}

export const ProductService = {
  searchProductCatalog,
} as const;
