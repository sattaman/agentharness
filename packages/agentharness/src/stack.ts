import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Agent } from './agent.js';
import { Auth } from './auth.js';
import type { AgentSpec } from './load.js';

export interface AgentHarnessStackProps extends StackProps {
  readonly stage: string;
  readonly agents: readonly AgentSpec[];
}

export const stackName = (stage: string): string => `agentharness-${stage}`;

export class AgentHarnessStack extends Stack {
  constructor(scope: Construct, { stage, agents, ...props }: AgentHarnessStackProps) {
    super(scope, stackName(stage), props);
    Tags.of(this).add('stage', stage);

    const auth = new Auth(this, 'Auth');
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.client.userPoolClientId });

    for (const spec of agents) {
      const agent = new Agent(this, spec.name, { spec, stage, auth });
      Tags.of(agent).add('agent', spec.name);
      new CfnOutput(this, `${spec.name}HarnessArn`, { value: agent.harness.attrArn });
    }
  }
}
