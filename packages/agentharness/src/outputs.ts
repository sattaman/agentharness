import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { stackName } from './stack.js';

export async function stackOutputs(stage: string): Promise<Map<string, string>> {
  const name = stackName(stage);
  const { Stacks } = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: name }),
  );
  const outputs = new Map<string, string>();
  for (const { OutputKey, OutputValue } of Stacks?.[0]?.Outputs ?? []) {
    if (OutputKey !== undefined && OutputValue !== undefined) outputs.set(OutputKey, OutputValue);
  }
  return outputs;
}

export function requireOutput(outputs: Map<string, string>, key: string): string {
  const value = outputs.get(key);
  if (value === undefined) throw new Error(`Stack output ${key} not found. Is the stack deployed?`);
  return value;
}
