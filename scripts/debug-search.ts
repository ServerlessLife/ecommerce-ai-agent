/** Debug: run the product search directly with env from cdk-outputs.json —
 * the raw vector-search scores side by side with the service's output. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DynamoDBClient, SearchVectorsCommand } from '@aws-sdk/client-dynamodb';
import { EmbeddingService } from '@sample/services/embedding-service';
import { ProductService } from '@sample/services/product-service';

const outputs = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '..', 'infra', 'cdk-outputs.json'), 'utf-8'),
) as Record<string, Record<string, string>>;

process.env.PRODUCTS_TABLE = outputs.SampleSharedStack.ProductsTableName.trim();
process.env.VECTOR_INDEX = outputs.SampleSharedStack.ProductsVectorIndexName.trim();
process.env.EMBEDDING_MODEL_ID = outputs.SampleSharedStack.EmbeddingModelId.trim();

const query = process.argv[2] ?? 'Which product is good for sleep?';
console.log('Query:', JSON.stringify(query));
console.log(
  'Table:',
  process.env.PRODUCTS_TABLE,
  '| Index:',
  process.env.VECTOR_INDEX,
  '| Model:',
  process.env.EMBEDDING_MODEL_ID,
);

// Raw vector search — print the REAL cosine scores, not the service's output.
const dynamo = new DynamoDBClient({});
const vector = await EmbeddingService.embedText(query, process.env.EMBEDDING_MODEL_ID!);
const raw = await dynamo.send(
  new SearchVectorsCommand({
    TableName: process.env.PRODUCTS_TABLE,
    IndexName: process.env.VECTOR_INDEX,
    SearchVector: vector.map((n) => ({ N: String(n) })),
    TopK: 10,
  }),
);
console.log(`Raw top-${raw.SearchResults?.length} by cosine (lower Score = closer):`);
for (const hit of raw.SearchResults ?? []) {
  const item = (hit.Item ?? {}) as { title?: { S?: string } };
  console.log(`  score=${hit.Score} ${item.title?.S}`);
}
console.log('--- service output (top 10) ---');

const { results } = await ProductService.searchProductCatalog(query);
console.log(`Got ${results.length} result(s):`);
for (const r of results.slice(0, 10)) {
  console.log(`  ${r.title} — ${(r.description ?? '').slice(0, 80)}`);
}
