/**
 * The widget's static host: the built chat page on a public S3 website
 * endpoint, shared by ALL implementations. Beside the page files the stack
 * writes `config.js` — the auth URL plus the backend list (id/label/invoke
 * URL/session header) — so the page stays backend-agnostic.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export type WidgetStackProps = cdk.StackProps & {
  sharedStackName: string;
  agentCoreStackName: string;
  /** The AgentCore V2 stack's name (the same agent on the V2 platform). */
  agentCoreV2StackName: string;
  /** The LambdaEvent (Function URL) stack's name — same export contract. */
  agentLambdaEventStackName: string;
  /** The LambdaWeb (Web Functions) stack's name — same export contract. */
  lambdaWebStackName: string;
};

export class WidgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WidgetStackProps) {
    super(scope, id, props);

    const authBaseUrl = cdk.Fn.importValue(`${props.sharedStackName}-AuthBaseUrl`);
    const agentCoreUrl = cdk.Fn.importValue(`${props.agentCoreStackName}-AgentCoreRuntimeUrl`);
    const agentCoreV2Url = cdk.Fn.importValue(`${props.agentCoreV2StackName}-AgentCoreRuntimeUrl`);
    const agentLambdaEventUrl = cdk.Fn.importValue(
      `${props.agentLambdaEventStackName}-AgentLambdaEventUrl`,
    );
    // LambdaWeb — the Web Functions variant's endpoint URL (like the other
    // agent backend entries: hardcoded export, dependency edge in the app).
    const agentLambdaWebUrl = cdk.Fn.importValue(`${props.lambdaWebStackName}-AgentLambdaWebUrl`);

    const widgetDir = path.join(__dirname, '..', '..', 'widget', 'dist');
    if (!existsSync(path.join(widgetDir, 'index.html'))) {
      throw new Error(
        `Widget build missing: ${widgetDir}/index.html — run \`npm run build:widget\` (Vite) before deploying.`,
      );
    }

    const websiteBucket = new s3.Bucket(this, 'WidgetBucket', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeployWidget', {
      sources: [
        s3deploy.Source.asset(widgetDir),
        // Written last (later sources override earlier ones): the deployed
        // environment's config. Entries may be added/removed here without
        // touching the widget code.
        s3deploy.Source.data(
          'config.js',
          `window.WIDGET_CONFIG = ${JSON.stringify({
            authUrl: authBaseUrl,
            backends: [
              {
                id: 'agentcore',
                label: 'AgentCore Runtime',
                url: agentCoreUrl,
                sessionHeader: 'x-amzn-bedrock-agentcore-runtime-session-id',
              },
              {
                id: 'agentcorev2',
                label: 'AgentCore V2',
                url: agentCoreV2Url,
                sessionHeader: 'x-amzn-bedrock-agentcore-runtime-session-id',
              },
              {
                id: 'lambdaevent',
                label: 'Lambda Event Function',
                url: agentLambdaEventUrl,
              },
              {
                id: 'lambdaweb',
                label: 'Lambda Web Function',
                url: agentLambdaWebUrl,
              },
            ],
          })};`,
        ),
      ],
      destinationBucket: websiteBucket,
      // Short cache — redeploys change config.js and the hashed bundle names.
      cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.minutes(5))],
    });

    new cdk.CfnOutput(this, 'WidgetUrl', {
      value: `http://${websiteBucket.bucketWebsiteDomainName}`,
      description: 'Widget page URL',
    });
  }
}
