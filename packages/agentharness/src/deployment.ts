import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { outputKeys, stackNames } from './stack.js';

export interface Credentials {
  readonly userPoolId: string;
  readonly clientId: string;
}

export async function findCredentials(stage: string): Promise<Credentials> {
  const output = await stackOutputs(stackNames.auth(stage));
  return { userPoolId: output(outputKeys.userPoolId), clientId: output(outputKeys.clientId) };
}

export async function findHarnessArn(stage: string, agent: string): Promise<string> {
  const output = await stackOutputs(stackNames.agents(stage));
  return output(outputKeys.harnessArn(agent));
}

async function stackOutputs(name: string): Promise<(key: string) => string> {
  const { Stacks } = await new CloudFormationClient().send(
    new DescribeStacksCommand({ StackName: name }),
  );
  const outputs = new Map(
    Stacks?.[0]?.Outputs?.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );

  return (key) => {
    const value = outputs.get(key);
    if (value === undefined) throw new Error(`${name} has no output ${key}. Is it deployed?`);
    return value;
  };
}
