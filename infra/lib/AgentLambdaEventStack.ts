/**
 * The Lambda Event Function implementation's own stack: the agent handler on
 * a Lambda Function URL with native response streaming. Auth is NONE on the
 * URL — the handler validates the JWT itself (see `lambda-event/handler.ts`).
 *
 * `NodejsFunction` bundles the TypeScript entry at deploy time; the AWS SDK
 * stays external because the runtime ships it.
 */
import * as path from 'node:path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { COST_TAG_KEY, costTagFor, readEnvironment } from '../util/GetCostExperimentSettings';
import { AUTH_CLIENT_ID, MODEL_ID, RERANK_MODEL_ID, RERANK_REGION } from './Config';

export type AgentLambdaEventStackProps = cdk.StackProps & {
  /** Name of the shared stack — the JWKS URL arrives as Fn.importValue of its hardcoded export. */
  sharedStackName: string;
};

export class AgentLambdaEventStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentLambdaEventStackProps) {
    super(scope, id, props);

    const jwksUrl = cdk.Fn.importValue(`${props.sharedStackName}-AuthJwksUrl`);
    const productsTableName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsTableName`);
    const vectorIndexName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsVectorIndexName`);
    const embeddingModelId = cdk.Fn.importValue(`${props.sharedStackName}-EmbeddingModelId`);
    const conversationsBucketName = cdk.Fn.importValue(
      `${props.sharedStackName}-ConversationsBucketName`,
    );

    // The shared data, imported by name.
    const productsTable = dynamodb.Table.fromTableName(this, 'ProductsTable', productsTableName);
    const conversationsBucket = s3.Bucket.fromBucketName(
      this,
      'ConversationsBucket',
      conversationsBucketName,
    );

    // Cost-test billing tag (`<environment>-lambdaevent`); undefined in demo deploys.
    const costTag = costTagFor(readEnvironment(), 'lambdaevent');

    // The reranker the `search_products` tool re-scores candidates with —
    // configured per deployment (see Config.ts; `null`: eu-west-1 offers no
    // rerank model).
    const rerankModelArn = RERANK_MODEL_ID
      ? `arn:aws:bedrock:${RERANK_REGION}::foundation-model/${RERANK_MODEL_ID}`
      : null;

    const role = new iam.Role(this, 'AgentLambdaEventRole', {
      roleName: `${this.stackName}-Agent-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the sample Lambda Event Function agent variant',
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    // Converse + InvokeModel (EU model ids are inference profiles); covers
    // the Titan embed model and the reranker ARN.
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:*`,
        ],
      }),
    );

    // bedrock:Rerank's documented policy scope is Resource "*".
    if (rerankModelArn) {
      role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:Rerank'],
          resources: ['*'],
        }),
      );
    }

    // Vector query grant — covers the table AND its vector index.
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:SearchVectors'],
        resources: [productsTable.tableArn, `${productsTable.tableArn}/index/${vectorIndexName}`],
      }),
    );

    // SessionManager snapshots go to the shared conversations bucket.
    conversationsBucket.grantReadWrite(role);

    // ── The function: nothing staged — NodejsFunction bundles at deploy time. ──

    const environment: Record<string, string> = {
      AUTH_CLIENT_ID,
      AUTH_JWKS_URL: jwksUrl,
      MODEL_ID,
      EMBEDDING_MODEL_ID: embeddingModelId,
      ...(rerankModelArn && {
        RERANK_MODEL_ARN: rerankModelArn,
        RERANK_REGION, // the rerank models are regional
      }),
      PRODUCTS_TABLE: productsTable.tableName,
      VECTOR_INDEX: vectorIndexName,
      CONVERSATIONS_BUCKET: conversationsBucket.bucketName,
    };

    // A streaming turn runs as long as the model needs; the URL streams while the handler is alive.
    const functionSettings = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // A streaming agent turn runs for as long as the model needs; the
      // Function URL streams the response while the handler is alive.
      timeout: cdk.Duration.minutes(3),
      memorySize: 1024,
      role,
    } as const;

    // One NodejsFunction — the plain TypeScript entry.
    const agentLambdaEvent = new nodejs.NodejsFunction(this, 'AgentLambdaEvent', {
      ...functionSettings,
      handler: 'handler',
      entry: path.join(__dirname, '..', '..', 'lambda-event', 'handler.ts'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
      environment,
    });

    // Cost-test billing tag. Tag the FUNCTION's Cfn resource only — tagging
    // the L2 would cascade to its auto-created log group and pull CloudWatch
    // ingestion into the tag line.
    if (costTag) {
      (agentLambdaEvent.node.defaultChild as lambda.CfnFunction).tags.setTag(COST_TAG_KEY, costTag);
    }

    // The function name and its log group as outputs — the log downloader reads them from the deploy outputs.
    new cdk.CfnOutput(this, 'AgentLambdaEventFunctionName', {
      value: agentLambdaEvent.functionName,
      description: 'Lambda Event Function name (cost attribution)',
      exportName: `${this.stackName}-AgentLambdaEventFunctionName`,
    });
    new cdk.CfnOutput(this, 'AgentLambdaEventLogGroup', {
      value: `/aws/lambda/${agentLambdaEvent.functionName}`,
      description: 'Lambda Event Function log group (REPORT lines = the cost input)',
    });
    if (costTag) {
      new cdk.CfnOutput(this, 'CostTag', {
        value: costTag,
        description: 'This deployment’s cost-experiment billing tag value',
      });
    }

    const url = agentLambdaEvent.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      // Native response streaming — SSE chunks flush as the agent produces them.
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ['*'],
        // OPTIONS/preflight is handled by the Function URL automatically.
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: [
          'authorization',
          'content-type',
          'x-amzn-bedrock-agentcore-runtime-session-id',
        ],
      },
    });

    new cdk.CfnOutput(this, 'AgentLambdaEventUrl', {
      value: url.url,
      description: 'Lambda Event Function URL (RESPONSE_STREAM)',
      exportName: `${this.stackName}-AgentLambdaEventUrl`,
    });
  }
}
