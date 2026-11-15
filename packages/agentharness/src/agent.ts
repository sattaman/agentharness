import { CfnHarness, type CfnHarnessProps } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { arn, fromThisAccount, serviceRole, type Permission } from './iam.js';
import { Knowledge } from './knowledge.js';
import type { AgentSpec } from './load.js';
import { harnessName as nameOf } from './names.js';
import { models } from './schema.js';

export interface AgentProps {
  readonly spec: AgentSpec;
  readonly stage: string;
}

export class Agent extends Construct {
  readonly harness: CfnHarness;
  readonly knowledge: Knowledge | undefined;

  constructor(scope: Construct, id: string, { spec, stage }: AgentProps) {
    super(scope, id);
    const harnessName = nameOf(stage, spec.name);
    const model = models[spec.config.model];
    this.knowledge = spec.knowledge
      ? new Knowledge(this, 'Knowledge', { name: `agentharness-${stage}-${spec.name}` })
      : undefined;
    const gatewayArn = this.knowledge?.gateway.attrGatewayArn;

    const inferenceProfile = arn('bedrock', `inference-profile/${model.modelId}`);
    const role = serviceRole(
      this,
      'ExecutionRole',
      fromThisAccount('bedrock-agentcore.amazonaws.com'),
      [
        {
          why: 'Call the configured model through its inference profile.',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [inferenceProfile],
        },
        {
          why: 'Global inference may serve the model from any region, but only through that profile, so a caller who overrides the model gets nowhere.',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [`arn:aws:bedrock:*::foundation-model/${model.foundationModel}`],
          conditions: { StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfile } },
        },
        {
          why: 'The runtime never switches roles; denied as AWS recommends for harness execution roles.',
          effect: Effect.DENY,
          actions: ['sts:AssumeRole'],
          resources: ['*'],
        },
        {
          why: 'Write runtime logs. The runtime names its log groups when it starts.',
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
          ],
          resources: [arn('logs', 'log-group:/aws/bedrock-agentcore/runtimes/*')],
        },
        {
          why: 'Find log groups, as in the AgentCore documented execution role.',
          actions: ['logs:DescribeLogGroups'],
          resources: [arn('logs', 'log-group:*')],
        },
        {
          why: 'Send traces and pull the runtime image. These actions have no resource-level permissions.',
          actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'xray:GetSamplingRules',
            'xray:GetSamplingTargets',
            'ecr-public:GetAuthorizationToken',
            'sts:GetServiceBearerToken',
          ],
          resources: ['*'],
        },
        {
          why: 'Publish runtime metrics, limited to the AgentCore namespace.',
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
        },
        {
          why: 'Exchange the caller token for a workload token. The runtime names identities harness_<name>-<id>.',
          actions: [
            'bedrock-agentcore:GetWorkloadAccessToken',
            'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          ],
          resources: [
            arn('bedrock-agentcore', 'workload-identity-directory/default'),
            arn(
              'bedrock-agentcore',
              `workload-identity-directory/default/workload-identity/harness_${harnessName}-*`,
            ),
          ],
        },
        ...(gatewayArn === undefined ? [] : [searchKnowledge(gatewayArn)]),
      ],
    );

    this.harness = new CfnHarness(this, 'Harness', {
      harnessName,
      executionRoleArn: role.roleArn,
      model: {
        bedrockModelConfig: {
          modelId: model.modelId,
          apiFormat: 'converse_stream',
          maxTokens: spec.config.maxTokens,
        },
      },
      systemPrompt: [{ text: spec.prompt }],
      ...toolsFor(gatewayArn),
      memory: { disabled: {} },
      truncation: { strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 20 } } },
      maxIterations: spec.config.maxIterations,
      maxTokens: spec.config.maxTokens,
      timeoutSeconds: spec.config.timeoutSeconds,
      environment: {
        agentCoreRuntimeEnvironment: {
          lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
        },
      },
    });
  }
}

const knowledgeTool = 'knowledge';

function toolsFor(gatewayArn: string | undefined): Pick<CfnHarnessProps, 'tools' | 'allowedTools'> {
  if (gatewayArn === undefined) return { tools: [], allowedTools: [] };
  return {
    tools: [
      {
        type: 'agentcore_gateway',
        name: knowledgeTool,
        config: { agentCoreGateway: { gatewayArn, outboundAuth: { awsIam: {} } } },
      },
    ],
    allowedTools: [`@${knowledgeTool}`],
  };
}

const searchKnowledge = (gatewayArn: string): Permission => ({
  why: 'Search this agent’s knowledge through its own gateway.',
  actions: ['bedrock-agentcore:InvokeGateway'],
  resources: [gatewayArn],
});
