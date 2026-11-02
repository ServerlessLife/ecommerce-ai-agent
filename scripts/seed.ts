/**
 * Seed the `products` table: fetch the DummyJSON catalog, Titan-embed each
 * product, overwrite the rows. Table and model come from the CDK outputs
 * file (`infra/cdk-outputs.json`; cost-test environments have their own
 * `cdk-outputs-<environment>.json`). AWS credentials from the default profile.
 *
 * Flags:
 *   --environment testN   seed a cost-test environment's own table (run right
 *                         after that environment's deploy)
 *   --drop-cleanup        delete every row instead of seeding (teardown)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { EmbeddingService } from '@sample/services/embedding-service';

const TABLE_NAME_OUTPUT = 'ProductsTableName';
const EMBED_MODEL_OUTPUT = 'EmbeddingModelId';
const DUMMYJSON_URL =
  'https://dummyjson.com/products?limit=0&select=id,title,description,price,stock';

function readOutput(stack: string, key: string, outputsPath: string): string {
  const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<
    string,
    Record<string, string>
  >;
  const value = outputs[stack]?.[key];
  if (!value) {
    throw new Error(
      `Missing ${stack}.${key} in ${outputsPath} — deploy that stack first (npm run deploy, or the cost-test deploy with -c environment=…).`,
    );
  }
  return value.trim();
}

const args = process.argv.slice(2);
const dropCleanup = args.includes('--drop-cleanup');
const environmentArg = args.indexOf('--environment');
const environment = environmentArg !== -1 ? (args[environmentArg + 1] ?? '') : undefined;
if (environment !== undefined && !/^[a-z0-9]+$/.test(environment)) {
  throw new Error(`--environment must be a lowercase [a-z0-9] string, got "${environment}".`);
}
// The cost-test shared stack deploys under the prefixed id — same capitalization as the CDK app's stackId().
const sharedStackName =
  environment === undefined
    ? 'SampleSharedStack'
    : `${environment.charAt(0).toUpperCase() + environment.slice(1)}SampleSharedStack`;
// Each environment's deploy writes its own outputs file.
const outputsPath = path.resolve(
  import.meta.dirname,
  '..',
  'infra',
  environment === undefined ? 'cdk-outputs.json' : `cdk-outputs-${environment}.json`,
);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = readOutput(sharedStackName, TABLE_NAME_OUTPUT, outputsPath);

if (dropCleanup) {
  // Teardown: delete every row (BatchWrite works on chunks of max 25).
  const scan = await doc.send(
    new ScanCommand({ TableName: tableName, ProjectionExpression: 'id' }),
  );
  const ids = (scan.Items ?? []).map((item) => item.id as string);
  for (let start = 0; start < ids.length; start += 25) {
    await doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: ids
            .slice(start, start + 25)
            .map((id) => ({ DeleteRequest: { Key: { id } } })),
        },
      }),
    );
  }
  console.log(`Dropped ${ids.length} rows from ${tableName}`);
} else {
  const res = await fetch(DUMMYJSON_URL);
  if (!res.ok) {
    throw new Error(`DummyJSON returned HTTP ${res.status}`);
  }
  const { products } = (await res.json()) as {
    products: { id: number; title: string; description: string; price: number; stock: number }[];
  };
  const embedModel = readOutput(sharedStackName, EMBED_MODEL_OUTPUT, outputsPath);

  for (const product of products) {
    const embedding = await EmbeddingService.embedText(
      `${product.title}. ${product.description}`,
      embedModel,
    );
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          id: String(product.id),
          title: product.title,
          description: product.description,
          price: product.price,
          stock: product.stock,
          embedding,
        },
      }),
    );
  }
  console.log(`Seeded ${products.length} products into ${tableName}`);
}
