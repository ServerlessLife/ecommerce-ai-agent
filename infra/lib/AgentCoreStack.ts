/**
 * The AgentCore implementation's own stack: the Runtime running the staged
 * artifact (NODE_22, AG-UI protocol, JWT authorizer from the shared stack),
 * plus the session-lifecycle bounds and USAGE_LOGS delivery — the cost knobs
 * of a microVM chat deployment.
 *
 * The artifact dir MUST exist at synth time — run `npm run package` first
 * (the root deploy/synth scripts chain it).
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { AgentCorePlatformVersion } from '../util/GetCostExperimentSettings';
import { COST_TAG_KEY, costTagFor, readEnvironment } from '../util/GetCostExperimentSettings';
import { AUTH_CLIENT_ID, MODEL_ID, RERANK_MODEL_ID, RERANK_REGION } from './Config';

/** Idle 120 s: above the 60 s platform floor; a longer pause costs a cold boot, not context (S3 restore). */
const IDLE_RUNTIME_SESSION_TIMEOUT = cdk.Duration.seconds(120);
/** Hard session lifetime — bounds one microVM's memory bill to an hour. */
const MAX_SESSION_LIFETIME = cdk.Duration.seconds(3600);

export type AgentCoreStackProps = cdk.StackProps & {
  /** Name of the shared stack — table names + the discovery URL arrive as Fn.importValue. */
  sharedStackName: string;
  /** 'V1' (default) or 'V2' — the same stack class runs side by side as the
   * demo pair and as cost-environment deployments, each with its own pinned
   * version. */
  platformVersionOverride?: AgentCorePlatformVersion;
  /** Suffix keeping the account-unique runtime names apart between stack instances (e.g. `_v2`, `_test1_v1`). */
  runtimeNameSuffix?: string;
};

export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const runtimeName = `sample_agent${props.runtimeNameSuffix ?? ''}`;
    const effectivePlatform = props.platformVersionOverride ?? 'V1';
    // The per-test billing tag (`<environment>-agentcorev1|agentcorev2`); undefined in demo deploys.
    const costTag = costTagFor(
      readEnvironment(),
      effectivePlatform === 'V2' ? 'agentcorev2' : 'agentcorev1',
    );
    const artifactDir = path.join(__dirname, '..', '..', 'agentcore', 'agentcore-package');
    // NODE_22 is the newest Node managed runtime; the entrypoint must be .js
    // (control-plane requirement) — ESM via the staged manifest's "type": "module".
    const entrypoint = 'dist/agentcore/bootstrap.js';

    if (!existsSync(artifactDir)) {
      throw new Error(
        `AgentCore artifact dir missing: ${artifactDir} — run "npm run package" (sample root) before synth/deploy.`,
      );
    }

    const productsTableName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsTableName`);
    const vectorIndexName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsVectorIndexName`);
    const embeddingModelId = cdk.Fn.importValue(`${props.sharedStackName}-EmbeddingModelId`);
    const discoveryUrl = cdk.Fn.importValue(`${props.sharedStackName}-AuthDiscoveryUrl`);
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

    // The reranker the `search_products` tool re-scores candidates with —
    // configured per deployment (see Config.ts). The ARN embeds the MODEL's
    // region; the client targets RERANK_REGION.
    const rerankModelArn = RERANK_MODEL_ID
      ? `arn:aws:bedrock:${RERANK_REGION}::foundation-model/${RERANK_MODEL_ID}`
      : null;

    const executionRole = new iam.Role(this, 'AgentCoreExecutionRole', {
      roleName: `${this.stackName}-AgentCore-${this.region}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the sample AgentCore Runtime',
    });

    // AgentCore attaches a resource policy to the runtime's log group on
    // creation and needs logs:PutResourcePolicy from the execution role —
    // the L2 does NOT grant it; without this, runtime creation hits
    // AccessDenied and runtime logs stay empty.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:PutResourcePolicy'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`,
        ],
      }),
    );

    // Converse + InvokeModel (EU model ids like `eu.amazon.*` are inference
    // profiles); the catalog scope covers the Titan embed model and the
    // reranker ARN.
    executionRole.addToPolicy(
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

    // bedrock:Rerank's documented policy scope is Resource "*" — scoped
    // foundation-model ARNs do NOT authorize it.
    if (rerankModelArn) {
      executionRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:Rerank'],
          resources: ['*'],
        }),
      );
    }

    // The tool's vector query grant — covers the table AND its vector index
    // (no L2 grant method covers index ARNs).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:SearchVectors'],
        resources: [productsTable.tableArn, `${productsTable.tableArn}/index/${vectorIndexName}`],
      }),
    );

    // SessionManager snapshots go to the shared conversations bucket.
    conversationsBucket.grantReadWrite(executionRole);

    // Per-session resource-consumption records (vCPU-hours / memory GB-hours
    // at 1 s granularity) — the cost input for the price-performance tests.
    const usageLogGroup = new logs.LogGroup(this, 'AgentCoreUsageLogs', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${runtimeName}-usage`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const agentRuntime = new bedrockagentcore.Runtime(this, 'AgentRuntime', {
      runtimeName,
      agentRuntimeArtifact: bedrockagentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: artifactDir,
        runtime: bedrockagentcore.AgentCoreRuntime.NODE_22,
        entrypoint: [entrypoint],
      }),
      executionRole,
      protocolConfiguration: bedrockagentcore.ProtocolType.AGUI,
      // No OpenTelemetry SDK in the artifact — TRACES delivery would deliver nothing.
      tracingEnabled: false,
      // Cost-test billing tag; the service-created DEFAULT endpoint child
      // never inherits tags — re-tag it after deploy (see the runbook).
      tags: costTag ? { [COST_TAG_KEY]: costTag } : undefined,
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: IDLE_RUNTIME_SESSION_TIMEOUT,
        maxLifetime: MAX_SESSION_LIFETIME,
      },
      loggingConfigs: [
        {
          logType: bedrockagentcore.LogType.USAGE_LOGS,
          destination: bedrockagentcore.LoggingDestination.cloudWatchLogs(usageLogGroup),
        },
      ],
      authorizerConfiguration: bedrockagentcore.RuntimeAuthorizerConfiguration.usingJWT(
        discoveryUrl,
        [AUTH_CLIENT_ID],
        [AUTH_CLIENT_ID],
      ),
      environmentVariables: {
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        MODEL_ID,
        EMBEDDING_MODEL_ID: embeddingModelId,
        ...(rerankModelArn && {
          RERANK_MODEL_ARN: rerankModelArn,
          // The region whose rerank endpoint the tool calls (the rerank
          // models are regional — may differ from this deployment's region).
          RERANK_REGION,
        }),
        PRODUCTS_TABLE: productsTable.tableName,
        VECTOR_INDEX: vectorIndexName,
        CONVERSATIONS_BUCKET: conversationsBucket.bucketName,
      },
    });

    // Runtime only after its role exists (fromCodeAsset's S3-read grant lands
    // on the role in bind()).
    agentRuntime.node.addDependency(executionRole);

    // The platform version is pinned per stack instance (prop) — set
    // EXPLICITLY because an update that OMITS `platformVersion` means "keep
    // the current version" (docs), so V2 → V1 requires sending 'V1'. The CFN
    // registry supports the property even though the L2 typing claims
    // otherwise. A V2 create/update takes minutes (snapshot prep); V2 caps
    // agent env vars at 1.5 KB.
    (agentRuntime.node.defaultChild as bedrockagentcore.CfnRuntime).addPropertyOverride(
      'PlatformVersion',
      effectivePlatform,
    );

    new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', {
      value: agentRuntime.agentRuntimeArn,
      description: 'AgentCore Runtime ARN',
      exportName: `${this.stackName}-AgentCoreRuntimeArn`,
    });
    new cdk.CfnOutput(this, 'AgentCoreRuntimeId', {
      value: agentRuntime.agentRuntimeId,
      description: 'AgentCore Runtime ID (the app log group derives from it)',
    });
    new cdk.CfnOutput(this, 'AgentCoreRuntimeName', {
      value: runtimeName,
      description: 'AgentCore Runtime NAME (the usage log group derives from it)',
    });
    new cdk.CfnOutput(this, 'AgentCoreUsageLogGroup', {
      value: `/aws/bedrock-agentcore/runtimes/${runtimeName}-usage`,
      description: 'Usage-records log group (the per-session cost input)',
    });
    if (costTag) {
      new cdk.CfnOutput(this, 'CostTag', {
        value: costTag,
        description: 'This deployment’s cost-experiment billing tag value',
      });
    }
    // The browser-facing invoke URL: the runtime ARN, percent-encoded into
    // the path (AgentCore routes `/runtimes/{arn}`) — the stack that owns the
    // runtime publishes it, so no client ever derives this URL.
    new cdk.CfnOutput(this, 'AgentCoreRuntimeUrl', {
      value: `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3A${this.region}%3A${this.account}%3Aruntime%2F${agentRuntime.agentRuntimeId}`,
      description: 'AgentCore invoke URL (runtime ARN percent-encoded into the path)',
      exportName: `${this.stackName}-AgentCoreRuntimeUrl`,
    });
  }
}
