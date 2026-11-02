/**
 * Shared resources: the products table (with its vector index), the
 * conversations bucket, and the toy JWT leg (KMS RSA key + a /token Lambda
 * on a Function URL). Cross-stack values cross ONLY as CloudFormation
 * exports with hardcoded stable names (`Fn.importValue` in consumers) —
 * never producer tokens, which generate fragile `ExportsOutput*` exports.
 *
 * COST TESTS (`environment` prop from `-c environment=testN`): deploys under
 * a prefixed id with environment-suffixed data names, so each environment
 * brings its own, independently seeded data set. Unset = the demo shape.
 */

import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { AUTH_CLIENT_ID, EMBED_MODEL_ID, VECTOR_DIMENSIONS, VECTOR_INDEX_NAME } from './Config';

export interface SharedStackProps extends cdk.StackProps {
  /** The cost-test environment (`test1`) — suffixes the physical data names.
   * `undefined` = the demo shape (unprefixed names). */
  environment?: string;
}

export class SharedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: SharedStackProps) {
    super(scope, id, props);

    const envSuffix = props?.environment !== undefined ? `-${props.environment}` : '';

    // ── Data: products (vector rows) + conversations (session snapshots) ──

    const productsTable = new dynamodb.Table(this, 'ProductsTable', {
      tableName: `sample-products${envSuffix}`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The REAL vector index (1024-dim COSINE on `embedding`), created with
    // the table via the CreateTable API's `VectorIndexes` — the L2 doesn't
    // model it, so the property override passes it straight into the resource.
    (productsTable.node.defaultChild as dynamodb.CfnTable).addPropertyOverride('VectorIndexes', [
      {
        IndexName: VECTOR_INDEX_NAME,
        VectorAttribute: { AttributeName: 'embedding' },
        Dimensions: VECTOR_DIMENSIONS,
        DistanceFunction: 'COSINE',
        Projection: { ProjectionType: 'ALL' },
      },
    ]);

    // Account-regional namespace: CloudFormation derives a collision-proof
    // physical name; the envSuffix keeps demo and test stacks apart.
    const conversationsBucket = new s3.Bucket(this, 'ConversationsBucket', {
      bucketNamePrefix: `sample-conversations${envSuffix}`,
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Session snapshots are demo-transient — expire them after 3 days.
      lifecycleRules: [{ expiration: cdk.Duration.days(3) }],
    });

    // ── Toy JWT leg ──
    // KMS RSA key: the private half never leaves KMS, so there is no secret
    // to store or rotate. Function URL auth NONE — tokens are the gate; CORS
    // on the URL lets the widget page mint one cross-origin.

    const jwtSigningKey = new kms.Key(this, 'JwtSigningKey', {
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      description: 'JWT signing key for the sample auth service',
      // Shortest allowed waiting period — a demo should clean up quickly.
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const authLambda = new nodejs.NodejsFunction(this, 'AuthLambda', {
      entry: path.join(__dirname, '..', '..', 'auth', 'lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        AUTH_CLIENT_ID,
        JWT_KEY_ARN: jwtSigningKey.keyArn,
        TOKEN_EXPIRY_SECONDS: '3600',
      },
    });
    jwtSigningKey.grant(authLambda, 'kms:Sign', 'kms:GetPublicKey');

    const authUrl = authLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ['content-type', 'authorization'],
      },
    });

    new cdk.CfnOutput(this, 'ProductsTableName', {
      value: productsTable.tableName,
      exportName: `${this.stackName}-ProductsTableName`,
    });
    new cdk.CfnOutput(this, 'ProductsVectorIndexName', {
      value: VECTOR_INDEX_NAME,
      exportName: `${this.stackName}-ProductsVectorIndexName`,
    });
    new cdk.CfnOutput(this, 'EmbeddingModelId', {
      value: EMBED_MODEL_ID,
      exportName: `${this.stackName}-EmbeddingModelId`,
    });
    new cdk.CfnOutput(this, 'ConversationsBucketName', {
      value: conversationsBucket.bucketName,
      exportName: `${this.stackName}-ConversationsBucketName`,
    });
    new cdk.CfnOutput(this, 'AuthBaseUrl', {
      value: authUrl.url,
      exportName: `${this.stackName}-AuthBaseUrl`,
    });
    new cdk.CfnOutput(this, 'AuthDiscoveryUrl', {
      value: `${authUrl.url}.well-known/openid-configuration`,
      exportName: `${this.stackName}-AuthDiscoveryUrl`,
    });
    new cdk.CfnOutput(this, 'AuthJwksUrl', {
      value: `${authUrl.url}.well-known/jwks.json`,
      exportName: `${this.stackName}-AuthJwksUrl`,
    });
  }
}
