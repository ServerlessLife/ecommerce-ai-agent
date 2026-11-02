#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AgentCoreStack } from '../lib/AgentCoreStack';
import { AgentLambdaEventStack } from '../lib/AgentLambdaEventStack';
import { AgentLambdaWebStack } from '../lib/AgentLambdaWebStack';
import { SharedStack } from '../lib/SharedStack';
import { WidgetStack } from '../lib/WidgetStack';
import { readEnvironment } from '../util/GetCostExperimentSettings';

// The sample's one CDK app:
//   SampleSharedStack              shared tables + toy auth;
//   SampleAgentCoreStack           AgentCore V1;  SampleAgentCoreV2Stack: V2;
//   SampleAgentLambdaEventStack    Function URL variant;
//   SampleAgentLambdaWebStack      Web Function variant;
//   SampleWidgetStack              the chat page's static host.
//
// Consumers read cross-stack values via Fn.importValue of hardcoded export
// names; explicit stack dependencies set deploy order.
//
// COST TESTS (`-c environment=testN`, optional): the SAME stacks deploy under
// prefixed ids with derived `cost-experiment` tags and their OWN shared data
// (seed each environment after its deploy — see price-perfomance-test/README.md);
// the widget stack is skipped. Deploy/destroy one environment via `TestN*`:
//   npx cdk deploy 'Test1*' -c environment=test1

const app = new cdk.App({});

// ── The environment switch ──
// `-c environment=test1` prefixes every stack id and carries the suffix into
// account-unique resource names (runtime `sample_agent_test1[_v2]`, web
// function `sample-agent-lambdaweb-test1`). No context = the demo names.
const environment = readEnvironment();
const stackId = (base: string): string =>
  environment === undefined
    ? base
    : environment.charAt(0).toUpperCase() + environment.slice(1) + base;

const shared = new SharedStack(app, stackId('SampleSharedStack'), {
  // environment-suffixed data names in cost-test deploys (demo = plain names)
  ...(environment !== undefined && { environment }),
});

const agentCore = new AgentCoreStack(app, stackId('SampleAgentCoreStack'), {
  sharedStackName: shared.stackName,
  // account-unique runtime name when an environment is set
  ...(environment !== undefined && { runtimeNameSuffix: `_${environment}` }),
});
agentCore.addStackDependency(shared);

// The SAME agent code on the V2 platform — a second Runtime in its own
// stack. The platform version is pinned by the prop (no context switch);
// the hard override pins THIS stack to V2.
const agentCoreV2 = new AgentCoreStack(app, stackId('SampleAgentCoreV2Stack'), {
  sharedStackName: shared.stackName,
  platformVersionOverride: 'V2',
  runtimeNameSuffix: environment === undefined ? '_v2' : `_${environment}_v2`,
});
agentCoreV2.addStackDependency(shared);

const agentLambdaEvent = new AgentLambdaEventStack(app, stackId('SampleAgentLambdaEventStack'), {
  sharedStackName: shared.stackName,
});
agentLambdaEvent.addStackDependency(shared);

const agentLambdaWeb = new AgentLambdaWebStack(app, stackId('SampleAgentLambdaWebStack'), {
  sharedStackName: shared.stackName,
});
agentLambdaWeb.addStackDependency(shared);

// The demo widget host is a DEMO concern — skipped with an environment
// context, so the demo config.js never gets test endpoints.
if (environment === undefined) {
  const widget = new WidgetStack(app, 'SampleWidgetStack', {
    sharedStackName: shared.stackName,
    agentCoreStackName: agentCore.stackName,
    agentCoreV2StackName: agentCoreV2.stackName,
    agentLambdaEventStackName: agentLambdaEvent.stackName,
    lambdaWebStackName: agentLambdaWeb.stackName,
  });
  widget.addStackDependency(shared);
  widget.addStackDependency(agentCore);
  widget.addStackDependency(agentCoreV2);
  widget.addStackDependency(agentLambdaEvent);
  widget.addStackDependency(agentLambdaWeb);
}
