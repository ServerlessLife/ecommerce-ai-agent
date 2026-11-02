/**
 * The LambdaWeb implementation's own stack: the agent's express server
 * deployed through the Web Functions form factor (launched 2026-10-12). CDK
 * has no classes for it yet, so the three resources are raw `CfnResource`s:
 *
 *   AWS::Lambda::WebFunction          function (name + tags);
 *   AWS::Lambda::WebFunctionRevision  immutable code+config snapshot —
 *                                     every deploy creates a new one, code
 *                                     read directly from our S3 bucket;
 *   AWS::Lambda::WebFunctionEndpoint  HTTPS endpoint, AuthType
 *                                     ApplicationManaged — no platform auth,
 *                                     the server's JWT middleware gates routes
 *                                     (see `lambda-web/index.ts`).
 *
 * Platform shape (docs 2026-10-13): nodejs24.x, Arm64, fixed 2 GB, revision
 * timeout 3–900 s, native response streaming, 512 MB package limit.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { COST_TAG_KEY, costTagFor, readEnvironment } from '../util/GetCostExperimentSettings';
import { AUTH_CLIENT_ID, MODEL_ID, RERANK_MODEL_ID, RERANK_REGION } from './Config';

/** The demo web function's physical name — REQUIRED by the
 * AWS::Lambda::WebFunction resource (the one place this sample pins a
 * physical compute name). Per-test stacks append the test name so parallel
 * test stacks never collide on the account-unique function name. */
const DEMO_FUNCTION_NAME = 'sample-agent-lambdaweb';

export type AgentLambdaWebStackProps = cdk.StackProps & {
  /** Name of the shared stack — the JWKS URL arrives as Fn.importValue of its hardcoded export. */
  sharedStackName: string;
};

export class AgentLambdaWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentLambdaWebStackProps) {
    super(scope, id, props);

    // CDK's bundled CloudFormation spec predates Web Functions — acknowledge
    // the validator rule until CDK ships the typed classes.
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::F3006',
      reason:
        'AWS::Lambda::WebFunction/Revision/Endpoint are registered CloudFormation resource types (launch 2026-10-12) that the bundled validator spec predates.',
    });

    const jwksUrl = cdk.Fn.importValue(`${props.sharedStackName}-AuthJwksUrl`);
    const productsTableName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsTableName`);
    const vectorIndexName = cdk.Fn.importValue(`${props.sharedStackName}-ProductsVectorIndexName`);
    const embeddingModelId = cdk.Fn.importValue(`${props.sharedStackName}-EmbeddingModelId`);
    const conversationsBucketName = cdk.Fn.importValue(
      `${props.sharedStackName}-ConversationsBucketName`,
    );

    const productsTable = dynamodb.Table.fromTableName(this, 'ProductsTable', productsTableName);
    const conversationsBucket = s3.Bucket.fromBucketName(
      this,
      'ConversationsBucket',
      conversationsBucketName,
    );

    const costTag = costTagFor(readEnvironment(), 'lambdaweb');
    const environmentName = readEnvironment();
    // The account-unique physical function name — the demo name, or the
    // per-environment name (`sample-agent-lambdaweb-test1`) when `-c environment=…`.
    const functionName =
      environmentName === undefined
        ? DEMO_FUNCTION_NAME
        : `${DEMO_FUNCTION_NAME}-${environmentName}`;

    const rerankModelArn = RERANK_MODEL_ID
      ? `arn:aws:bedrock:${RERANK_REGION}::foundation-model/${RERANK_MODEL_ID}`
      : null;

    // ── Execution role — the SAME grants as the Function URL variant. ──
    const role = new iam.Role(this, 'AgentLambdaWebRole', {
      roleName: `${this.stackName}-Agent-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the sample Lambda Web Function agent variant',
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
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
    if (rerankModelArn) {
      role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:Rerank'],
          resources: ['*'],
        }),
      );
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:SearchVectors'],
        resources: [productsTable.tableArn, `${productsTable.tableArn}/index/${vectorIndexName}`],
      }),
    );
    conversationsBucket.grantReadWrite(role);

    // ── The revision's env — the SAME set as the Function URL variant ──
    //    (the web function's listen address arrives via AWS_LAMBDA_HTTP_ENDPOINT
    //    at runtime).
    const environment: Record<string, string> = {
      AUTH_CLIENT_ID,
      AUTH_JWKS_URL: jwksUrl,
      MODEL_ID,
      EMBEDDING_MODEL_ID: embeddingModelId,
      ...(rerankModelArn && {
        RERANK_MODEL_ARN: rerankModelArn,
        // The region whose rerank endpoint the tool calls (the rerank models
        // are regional — may differ from this deployment's region).
        RERANK_REGION,
      }),
      PRODUCTS_TABLE: productsTable.tableName,
      VECTOR_INDEX: vectorIndexName,
      CONVERSATIONS_BUCKET: conversationsBucket.bucketName,
    };

    // ── The packages bucket: versioned (each revision pins an object version)
    // and readable by the Lambda service principal only for this function. ──
    const packagesBucket = new s3.Bucket(this, 'WebPackageBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    packagesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`${packagesBucket.bucketArn}/*`],
        conditions: {
          // ArnLike covers BOTH the create-time validation (the service
          // presents the FUNCTION arn — the revision does not exist yet) and
          // the `…/revision/*` runtime reads.
          ArnLike: {
            'aws:SourceArn': `arn:aws:lambda:${this.region}:${this.account}:web-function/${functionName}*`,
          },
        },
      }),
    );

    // ── The code package: zipped and uploaded by a BucketDeployment. The key
    // is content-hashed, so each deploy lands a NEW object — prune stays OFF
    // because immutable revisions may still pin old versions. ──
    const packageDir = path.join(__dirname, '..', '..', 'lambda-web', 'lambda-web-package');
    if (!existsSync(path.join(packageDir, 'index.js'))) {
      throw new Error(
        `LambdaWeb package missing: ${packageDir} — run \`npm run package -w @sample/lambda-web\` before deploying.`,
      );
    }
    const packageDeployment = new s3deploy.BucketDeployment(this, 'DeployWebPackage', {
      sources: [s3deploy.Source.asset(packageDir)],
      destinationBucket: packagesBucket,
      // Upload the ZIP AS the object (no extraction) — that is what makes
      // `objectVersionIds` available for the revision's version pinning.
      extract: false,
      prune: false,
    });

    // ── The three Web Function resources (raw CFN). ──
    const webFunction = new cdk.CfnResource(this, 'AgentWebFunction', {
      type: 'AWS::Lambda::WebFunction',
      properties: {
        FunctionName: functionName,
        ...(costTag && { Tags: [{ Key: COST_TAG_KEY, Value: costTag }] }),
      },
    });

    const webFunctionRevision = new cdk.CfnResource(this, 'AgentWebFunctionRevision', {
      type: 'AWS::Lambda::WebFunctionRevision',
      properties: {
        FunctionName: functionName,
        Description: 'sample agent',
        BuildConfig: {
          CodeConfig: {
            S3Object: {
              Bucket: packagesBucket.bucketName,
              // `objectKeys`/`objectVersionIds` are single-entry token lists.
              Key: cdk.Fn.select(0, packageDeployment.objectKeys),
              VersionId: cdk.Fn.select(0, packageDeployment.objectVersionIds),
            },
          },
          RuntimeConfig: { Runtime: 'nodejs24.x' },
        },
        ServiceConfig: {
          ExecutionRoleArn: role.roleArn,
          TimeoutSeconds: 180,
          EnvironmentVariables: environment,
          // Pin systemLogLevel for deterministic JSON platform-event cost input.
          TelemetryConfig: {
            LoggingConfig: {
              SystemLogLevel: 'INFO',
            },
          },
        },
      },
    });
    // The revision may only be created once its package object exists.
    webFunctionRevision.node.addDependency(packageDeployment);

    const webFunctionEndpoint = new cdk.CfnResource(this, 'AgentWebFunctionEndpoint', {
      type: 'AWS::Lambda::WebFunctionEndpoint',
      properties: {
        FunctionName: functionName,
        EndpointName: 'agent',
        EndpointType: 'HomeRegion',
        AuthType: 'ApplicationManaged',
        // The CFN-expressible form of the CLI's auto-deploy-to-latest: all
        // traffic on the revision this stack created (the GetAtt also makes
        // the endpoint depend on the revision, so CFN creates it first).
        RevisionWeights: [
          {
            RevisionId: webFunctionRevision.getAtt('RevisionId').toString(),
            Weight: 100,
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'AgentLambdaWebFunctionName', {
      value: functionName,
      description: 'LambdaWeb agent web function name (cost attribution)',
      exportName: `${this.stackName}-AgentLambdaWebFunctionName`,
    });
    new cdk.CfnOutput(this, 'AgentLambdaWebLogGroup', {
      value: `/aws/lambda/web/${functionName}`,
      description: 'LambdaWeb centralized log group (platform.* events = the cost input)',
    });
    new cdk.CfnOutput(this, 'AgentLambdaWebFunctionArn', {
      value: webFunction.getAtt('FunctionArn').toString(),
      description: 'LambdaWeb agent web function ARN (tag verification, cost attribution)',
      exportName: `${this.stackName}-AgentLambdaWebFunctionArn`,
    });
    if (costTag) {
      new cdk.CfnOutput(this, 'CostTag', {
        value: costTag,
        description: 'This deployment’s cost-experiment billing tag value',
      });
    }
    new cdk.CfnOutput(this, 'AgentLambdaWebUrl', {
      value: `https://${webFunctionEndpoint.getAtt('DomainName').toString()}`,
      description: 'LambdaWeb agent endpoint URL (HTTPS, ApplicationManaged auth)',
      exportName: `${this.stackName}-AgentLambdaWebUrl`,
    });
  }
}
