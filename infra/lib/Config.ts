/** The demo's ids/names, written once and shared by the CDK stacks. */

/** The chat LLM. */
export const MODEL_ID = 'openai.gpt-oss-20b-1:0';

/** The one Titan embed model for BOTH seeding and query embedding. */
export const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/** Reranker disabled (`null`): no eu-west-1 rerank model. */
export const RERANK_MODEL_ID: string | null = null;
/** The region whose rerank endpoint the tool calls when rerank is enabled. */
export const RERANK_REGION = 'eu-central-1';

/** The DynamoDB vector index name (queried via the SearchVectors API). */
export const VECTOR_INDEX_NAME = 'ProductsVectorIndex';

/** Dimensions of the `embedding` attribute — matches Titan Embeddings. */
export const VECTOR_DIMENSIONS = 1024;

/** Toy auth: the OAuth client id AND the JWT audience of every token. */
export const AUTH_CLIENT_ID = 'sample-chat';
