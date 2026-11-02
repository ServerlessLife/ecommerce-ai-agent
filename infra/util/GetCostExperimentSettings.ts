/**
 * The cost-test deploy switch, read from the CDK toolkit's context
 * (`CDK_CONTEXT_JSON`).
 *
 * `-c environment=testN` (optional) deploys the SAME stacks under prefixed
 * ids (`Test1SampleAgentLambdaWebStack`, …), each carrying the
 * `cost-experiment` billing tag `<environment>-<platformKey>` so Cost
 * Explorer splits the bill per environment+platform. Unset = the demo's
 * default shape, untagged.
 *
 * The AgentCore platform version is NOT a context switch — each stack pins
 * its own via `AgentCoreStackProps.platformVersionOverride`.
 */

const COST_TAG_KEY = 'cost-experiment';

/** The AgentCore Runtime platform version ('V1' | 'V2'). */
export type AgentCorePlatformVersion = 'V1' | 'V2';

const readExperimentContext = (): Record<string, unknown> =>
  JSON.parse(process.env.CDK_CONTEXT_JSON ?? '{}') as Record<string, unknown>;

/** The optional `-c environment=…` context value — `undefined` in demo deploys. */
export const readEnvironment = (): string | undefined => {
  const raw = readExperimentContext().environment;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !/^[a-z0-9]+$/.test(raw)) {
    throw new Error(
      `CDK context environment must be a lowercase [a-z0-9] string, got "${String(raw)}".`,
    );
  }
  return raw;
};

/** The stack's `cost-experiment` tag value: `<environment>-<platformKey>`, or
 * `undefined` (no tags) when environment is unset. */
export const costTagFor = (
  environment: string | undefined,
  platformKey: 'lambdaevent' | 'lambdaweb' | 'agentcorev1' | 'agentcorev2',
): string | undefined => (environment === undefined ? undefined : `${environment}-${platformKey}`);

export { COST_TAG_KEY };
