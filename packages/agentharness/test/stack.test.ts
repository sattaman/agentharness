import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import type { AgentSpec } from '../src/load.js';
import { AgentsStack, AuthStack } from '../src/stack.js';

const helper: AgentSpec = {
  name: 'helper',
  prompt: 'You are a test agent.',
  config: { model: 'nova-2-lite', maxTokens: 512, maxIterations: 3, timeoutSeconds: 60 },
  knowledge: { dir: 'knowledge', files: ['office.md'] },
};
const plain: AgentSpec = { ...helper, name: 'plain', knowledge: undefined };

const app = createApp();
const authStack = new AuthStack(app, { stage: 'test' });
const agentsStack = new AgentsStack(app, {
  stage: 'test',
  auth: authStack.auth,
  agents: [helper, plain],
});
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

function statementsOf(service: string) {
  const roles = template.findResources('AWS::IAM::Role', {
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
      AllowedTools: ['@knowledge'],
      Memory: { Disabled: {} },
      MaxIterations: 3,
      TimeoutSeconds: 60,
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: Match.anyValue(),
          AllowedClients: [Match.anyValue()],
          AllowedScopes: ['agentharness/invoke'],
        },
      },
    });
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
          Name: 'knowledge',
          Config: {
            AgentCoreGateway: { GatewayArn: Match.anyValue(), OutboundAuth: { AwsIam: {} } },
          },
        },
      ],
    });
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
  it('issues machine tokens only, scoped to invoking agents', () => {
    authTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_CLIENT_TOKEN_AUTH'],
      GenerateSecret: true,
      AllowedOAuthFlows: ['client_credentials'],
      AllowedOAuthScopes: [Match.anyValue()],
    });
    authTemplate.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'agentharness',
      Scopes: [{ ScopeName: 'invoke', ScopeDescription: 'Call agents' }],
    });
    authTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('is protected from accidental deletion', () => {
    expect(authStack.terminationProtection).toBe(true);
  });
});
