import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { chatRequestSchema } from '../src/request.js';
import type { AgentSpec } from '../src/load.js';
import { AgentsStack, AuthStack } from '../src/stack.js';

const helper: AgentSpec = {
  name: 'helper',
  prompt: 'You are a test agent.',
  config: {
    model: 'nova-2-lite',
    maxTokens: 512,
    maxIterations: 3,
    timeoutSeconds: 60,
    callers: ['support'],
  },
  knowledge: { dir: 'knowledge', files: ['office.md'] },
};
const plain: AgentSpec = {
  ...helper,
  name: 'plain',
  knowledge: undefined,
  config: { ...helper.config, callers: [] },
};

const app = createApp();
const authStack = new AuthStack(app, {
  stage: 'test',
  agents: [helper, plain],
  callers: { support: { monthlyBudgetUsd: 20 } },
});
const agentsStack = new AgentsStack(app, { stage: 'test', agents: [helper, plain] });
const template = Template.fromStack(agentsStack);
const authTemplate = Template.fromStack(authStack);

const roleSchema = z.object({
  Properties: z.object({
    Policies: z.array(
      z.object({
        PolicyDocument: z.object({
          Statement: z.array(
            z.object({
              Effect: z.string(),
              Action: z.union([z.string(), z.array(z.string())]),
              Resource: z.unknown(),
              Condition: z.unknown().optional(),
            }),
          ),
        }),
      }),
    ),
  }),
});

const clientSchema = z.object({
  Properties: z.object({ ClientName: z.string(), AllowedOAuthScopes: z.unknown() }),
});

function statementsOf(service: string, from = template) {
  const roles = from.findResources('AWS::IAM::Role', {
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: service } })],
      },
    },
  });
  return Object.values(roles).flatMap((role) =>
    roleSchema.parse(role).Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement),
  );
}

describe('AgentsStack', () => {
  it('creates a locked-down harness per agent', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'agentharness_test_helper',
      Model: { BedrockModelConfig: { ModelId: 'global.amazon.nova-2-lite-v1:0', MaxTokens: 512 } },
      SystemPrompt: [{ Text: 'You are a test agent.' }],
      AllowedTools: ['@tools/knowledge___Retrieve'],
      Memory: { Disabled: {} },
      Truncation: { Strategy: 'sliding_window', Config: { SlidingWindow: { MessagesCount: 20 } } },
      MaxIterations: 3,
      MaxTokens: 512,
      TimeoutSeconds: 60,
      Environment: {
        AgentCoreRuntimeEnvironment: {
          LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 3600 },
        },
      },
      AuthorizerConfiguration: Match.absent(),
    });
  });

  it('accepts only IAM-signed calls, so tokens work only through the front door', () => {
    const harnesses = Object.values(template.findResources('AWS::BedrockAgentCore::Harness'));
    expect(harnesses).toHaveLength(2);
    for (const harness of harnesses) {
      expect(harness['Properties']).not.toHaveProperty('AuthorizerConfiguration');
    }
  });

  it('does not depend on the auth stack', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });

  it('gives an agent without knowledge no tools', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'agentharness_test_plain',
      Tools: [],
      AllowedTools: [],
    });
  });

  it('creates a knowledge base, gateway and tool only for agents with knowledge', () => {
    template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      Name: 'agentharness-test-helper',
      KnowledgeBaseConfiguration: {
        Type: 'MANAGED',
        ManagedKnowledgeBaseConfiguration: { EmbeddingModelType: 'MANAGED' },
      },
    });
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: {
        Type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        ManagedKnowledgeBaseConnectorConfiguration: {
          ConnectorParameters: Match.objectLike({
            type: 'S3',
            connectionConfiguration: {
              bucketName: Match.anyValue(),
              bucketOwnerAccountId: { Ref: 'AWS::AccountId' },
            },
          }),
        },
      },
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'AWS_IAM',
      ProtocolType: 'MCP',
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'knowledge',
      TargetConfiguration: {
        Mcp: {
          Connector: {
            Source: { ConnectorId: 'bedrock-knowledge-bases' },
            Configurations: [{ Name: 'Retrieve', ParameterValues: Match.anyValue() }],
          },
        },
      },
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'agentharness_test_helper',
      Tools: [
        {
          Type: 'agentcore_gateway',
          Name: 'tools',
          Config: {
            AgentCoreGateway: { GatewayArn: Match.anyValue(), OutboundAuth: { AwsIam: {} } },
          },
        },
      ],
    });
  });

  it('gives each gateway one target per enabled capability, and the harness only that gateway', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    const invokes = statementsOf('bedrock-agentcore.amazonaws.com').filter(({ Action }) =>
      [Action].flat().includes('bedrock-agentcore:InvokeGateway'),
    );
    expect(invokes).toEqual([
      expect.objectContaining({
        Resource: { 'Fn::GetAtt': [expect.stringMatching(/^helperGateway/), 'GatewayArn'] },
      }),
    ]);
  });

  it('creates the harness only after its gateway targets', () => {
    const [harness] = Object.values(
      template.findResources('AWS::BedrockAgentCore::Harness', {
        Properties: { HarnessName: 'agentharness_test_helper' },
      }),
    );
    const [target] = Object.keys(template.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    expect(harness?.['DependsOn']).toEqual(expect.arrayContaining([target]));
  });

  it('keeps the knowledge bucket private', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('lets the gateway search only its own knowledge base', () => {
    const statements = statementsOf('bedrock-agentcore.amazonaws.com').filter(({ Action }) =>
      [Action].flat().includes('bedrock:Retrieve'),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Resource).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^helperKnowledgeKnowledgeBase/), 'KnowledgeBaseArn'],
    });
  });

  it('lets the harness invoke the model only through its inference profile', () => {
    const invoke = statementsOf('bedrock-agentcore.amazonaws.com').filter(({ Action }) =>
      [Action].flat().some((action) => action.startsWith('bedrock:Invoke')),
    );
    const viaProfile = invoke.filter(({ Condition }) => Condition === undefined);
    const foundationModel = invoke.filter(({ Condition }) => Condition !== undefined);
    expect(viaProfile).toHaveLength(2);
    expect(foundationModel).toHaveLength(2);
    foundationModel.forEach(({ Resource, Condition }, i) => {
      expect(Resource).toBe('arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0');
      expect(Condition).toEqual({
        StringEquals: { 'bedrock:InferenceProfileArn': viaProfile[i]?.Resource },
      });
    });
  });

  it('denies the harness switching roles', () => {
    const denies = statementsOf('bedrock-agentcore.amazonaws.com').filter(
      ({ Effect }) => Effect === 'Deny',
    );
    expect(denies).toEqual([
      expect.objectContaining({ Action: 'sts:AssumeRole', Resource: '*' }),
      expect.objectContaining({ Action: 'sts:AssumeRole', Resource: '*' }),
    ]);
  });

  it('tags resources with stage and agent', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Tags: Match.arrayWith([
        { Key: 'agent', Value: 'helper' },
        { Key: 'stage', Value: 'test' },
      ]),
    });
  });
});

describe('AuthStack', () => {
  // The nightly cleanup deletes only the agents stack, so anything that bills while idle
  // must live there. Each type here costs nothing until it is used, apart from a few
  // cents of storage (checked against the AWS Price List, 2026-11-18). Before adding a
  // type, check that it is free when idle; otherwise put it in the agents stack.
  it('contains only resources that cost nothing while idle', () => {
    const freeWhenIdle = new Set([
      'AWS::ApiGateway::Authorizer',
      'AWS::ApiGateway::Deployment',
      'AWS::ApiGateway::Method',
      'AWS::ApiGateway::Model',
      'AWS::ApiGateway::RequestValidator',
      'AWS::ApiGateway::Resource',
      'AWS::ApiGateway::RestApi',
      'AWS::ApiGateway::Stage',
      'AWS::CDK::Metadata',
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolClient', // M2M app clients: $0; token requests are billed
      'AWS::Cognito::UserPoolResourceServer',
      'AWS::DynamoDB::Table', // on demand: storage only
      'AWS::IAM::Role',
      'AWS::Lambda::Function',
      'AWS::Lambda::Permission',
      'AWS::Logs::LogGroup', // storage only
    ]);
    const { Resources } = z
      .object({ Resources: z.record(z.string(), z.object({ Type: z.string() })) })
      .parse(authTemplate.toJSON());
    const types = Object.values(Resources).map(({ Type }) => Type);
    expect(types.filter((type) => !freeWhenIdle.has(type))).toEqual([]);
  });

  it('defines one scope per agent', () => {
    authTemplate.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'agentharness',
      Scopes: [
        { ScopeName: 'helper', ScopeDescription: 'Call helper' },
        { ScopeName: 'plain', ScopeDescription: 'Call plain' },
      ],
    });
  });

  it('gives maintainers every agent and each caller only the agents that name it', () => {
    const clients = authTemplate.findResources('AWS::Cognito::UserPoolClient');
    const scopesOf = (name: string): string =>
      JSON.stringify(
        Object.values(clients)
          .map((client) => clientSchema.parse(client).Properties)
          .find(({ ClientName }) => ClientName === name)?.AllowedOAuthScopes,
      );
    expect(Object.keys(clients)).toHaveLength(2);
    expect(scopesOf('maintainers')).toMatch(/helper.*plain/);
    expect(scopesOf('support')).toContain('helper');
    expect(scopesOf('support')).not.toContain('plain');
  });

  it('issues machine tokens only', () => {
    const clients = Object.values(authTemplate.findResources('AWS::Cognito::UserPoolClient'));
    for (const client of clients) {
      expect(client['Properties']).toMatchObject({
        ExplicitAuthFlows: ['ALLOW_CLIENT_TOKEN_AUTH'],
        GenerateSecret: true,
        AllowedOAuthFlows: ['client_credentials'],
      });
    }
    authTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('puts a Cognito-authorized, validated, streaming front door before the agents', () => {
    authTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizationScopes: ['agentharness/helper', 'agentharness/plain'],
      RequestValidatorId: Match.anyValue(),
      Integration: Match.objectLike({ Type: 'AWS_PROXY', ResponseTransferMode: 'STREAM' }),
    });
    authTemplate.hasResourceProperties('AWS::ApiGateway::Model', {
      Schema: Match.objectLike({ additionalProperties: false, required: Match.anyValue() }),
    });
    authTemplate.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 })],
    });
  });

  it('validates bodies at the gateway with exactly the schema the front door uses', () => {
    const models = Object.values(authTemplate.findResources('AWS::ApiGateway::Model'));
    expect(models).toHaveLength(1);
    const model = z.object({ Properties: z.object({ Schema: z.unknown() }) }).parse(models[0]);
    expect(model.Properties.Schema).toEqual(
      z.toJSONSchema(chatRequestSchema, { target: 'draft-4' }),
    );
  });

  it('lets the front door invoke this stage’s agents and nothing more', () => {
    const actions = statementsOf('lambda.amazonaws.com', authTemplate).flatMap(({ Action }) =>
      [Action].flat(),
    );
    expect(actions.sort()).toEqual([
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:InvokeHarness',
      'cloudformation:DescribeStacks',
      'dynamodb:UpdateItem',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    ]);
    expect(JSON.stringify(authTemplate.toJSON())).toContain('harness/agentharness_test_*');
  });

  it('keeps a retained, recoverable spend ledger', () => {
    authTemplate.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
  });

  it('gives the front door a fixed role name for the budget backstop', () => {
    authTemplate.hasResourceProperties('AWS::IAM::Role', {
      RoleName: { 'Fn::Join': ['', ['agentharness-test-frontdoor-', { Ref: 'AWS::Region' }]] },
    });
  });

  it('hands the front door each caller’s budget, defaulting to $5', () => {
    const env = JSON.stringify(
      authTemplate.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'index.handler' },
      }),
    );
    expect(env).toContain('\\"caller\\":\\"support\\"');
    expect(env).toContain('\\"budgetMicros\\":20000000');
    expect(env).toContain('\\"budgetMicros\\":5000000');
  });

  it('is protected from accidental deletion', () => {
    expect(authStack.terminationProtection).toBe(true);
  });
});
