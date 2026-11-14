import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Agent } from './agent.js';
import { Auth } from './auth.js';
import type { AgentSpec } from './load.js';

export const stackNames = {
  auth: (stage: string): string => `agentharness-${stage}-auth`,
  agents: (stage: string): string => `agentharness-${stage}-agents`,
};

export const outputKeys = {
  userPoolId: 'UserPoolId',
  clientId: 'ClientId',
  harnessArn: (agent: string): string => `${agent}HarnessArn`,
};

export interface StageProps extends StackProps {
  readonly stage: string;
}

export class AuthStack extends Stack {
  readonly auth: Auth;

  constructor(scope: Construct, { stage, ...props }: StageProps) {
    super(scope, stackNames.auth(stage), {
      description: 'Long-lived credentials for calling agentharness agents.',
      terminationProtection: true,
      ...props,
    });
    Tags.of(this).add('stage', stage);

    this.auth = new Auth(this, 'Auth');
    new CfnOutput(this, outputKeys.userPoolId, { value: this.auth.userPool.userPoolId });
    new CfnOutput(this, outputKeys.clientId, { value: this.auth.client.userPoolClientId });
  }
}

export interface AgentsStackProps extends StageProps {
  readonly agents: readonly AgentSpec[];
  readonly auth: Auth;
}

export class AgentsStack extends Stack {
  constructor(scope: Construct, { stage, agents, auth, ...props }: AgentsStackProps) {
    super(scope, stackNames.agents(stage), props);
    Tags.of(this).add('stage', stage);

    for (const spec of agents) {
      const agent = new Agent(this, spec.name, { spec, stage, authorizer: auth.jwtAuthorizer });
      Tags.of(agent).add('agent', spec.name);
      new CfnOutput(this, outputKeys.harnessArn(spec.name), { value: agent.harness.attrArn });
    }
  }
}
