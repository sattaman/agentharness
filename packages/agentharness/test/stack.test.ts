import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AgentHarnessStack } from '../src/stack.js';

const helper = {
  name: 'helper',
  prompt: 'You are a test agent.',
  config: { model: 'nova-2-lite', maxTokens: 512, maxIterations: 3, timeoutSeconds: 60 },
} as const;

function synth(): Template {
  return Template.fromStack(
    new AgentHarnessStack(createApp(), { stage: 'test', agents: [helper] }),
  );
}

describe('AgentHarnessStack', () => {
  it('creates a locked-down harness per agent', () => {
    synth().hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'agentharness_test_helper',
      Model: { BedrockModelConfig: { ModelId: 'global.amazon.nova-2-lite-v1:0', MaxTokens: 512 } },
      SystemPrompt: [{ Text: 'You are a test agent.' }],
      AllowedTools: [],
      Memory: { Disabled: {} },
      MaxIterations: 3,
      TimeoutSeconds: 60,
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: { DiscoveryUrl: Match.anyValue(), AllowedClients: [Match.anyValue()] },
      },
    });
  });

  it('only lets the execution role invoke the configured model', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: [
              Match.anyValue(),
              'arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0',
            ],
          }),
        ]),
      },
    });
  });

  it('tags resources with stage and agent', () => {
    synth().hasResourceProperties('AWS::IAM::Role', {
      Tags: Match.arrayWith([
        { Key: 'agent', Value: 'helper' },
        { Key: 'stage', Value: 'test' },
      ]),
    });
  });

  it('does not allow self sign-up', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });
});
