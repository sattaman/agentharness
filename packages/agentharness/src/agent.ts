import { Stack, Validations } from 'aws-cdk-lib';
import { CfnHarness } from 'aws-cdk-lib/aws-bedrockagentcore';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { Auth } from './auth.js';
import type { AgentSpec } from './load.js';
import { models } from './schema.js';

export interface AgentProps {
  readonly spec: AgentSpec;
  readonly stage: string;
  readonly auth: Auth;
}

export class Agent extends Construct {
  readonly harness: CfnHarness;

  constructor(scope: Construct, id: string, { spec, stage, auth }: AgentProps) {
    super(scope, id);
    const { account, region } = Stack.of(this);
    const harnessName = `agentharness_${stage}_${spec.name}`;
    const model = models[spec.config.model];

    const role = new Role(this, 'ExecutionRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': account } },
      }),
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${model.modelId}`,
          `arn:aws:bedrock:*::foundation-model/${model.foundationModel}`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'ecr-public:GetAuthorizationToken',
          'sts:GetServiceBearerToken',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/harness_${harnessName}-*`,
        ],
      }),
    );
    const wildcards: Record<string, string> = {
      [`arn:aws:bedrock:*::foundation-model/${model.foundationModel}`]:
        'Global inference profiles route to the foundation model in any region.',
      'arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/*':
        'The runtime creates its log groups per harness.',
      'arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:*':
        'Matches the AgentCore documented execution role: DescribeLogGroups lists across the account.',
      [`arn:aws:bedrock-agentcore:<AWS::Region>:<AWS::AccountId>:workload-identity-directory/default/workload-identity/harness_${harnessName}-*`]:
        'The runtime names workload identities harness_<harnessName>-<id>.',
      '*': 'X-Ray, ECR Public auth and CloudWatch metrics have no resource-level permissions.',
    };
    for (const [resource, reason] of Object.entries(wildcards)) {
      Validations.of(role).acknowledge({
        id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`,
        reason,
      });
    }

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
      allowedTools: [],
      memory: { disabled: {} },
      maxIterations: spec.config.maxIterations,
      timeoutSeconds: spec.config.timeoutSeconds,
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: auth.discoveryUrl,
          allowedClients: [auth.client.userPoolClientId],
        },
      },
    });
    this.harness.node.addDependency(role);
  }
}
