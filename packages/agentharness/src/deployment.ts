import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { outputKeys, stackNames } from './names.js';

export async function findHarnessArn(stage: string, agent: string): Promise<string> {
  const outputs = await stackOutputs(stackNames.agents(stage));
  return outputs.get(outputKeys.harnessArn(agent));
}

export interface KnowledgeTarget {
  readonly bucket: string;
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
}

export async function findKnowledge(
  stage: string,
  agent: string,
): Promise<KnowledgeTarget | undefined> {
  const outputs = await stackOutputs(stackNames.agents(stage));
  const bucket = outputs.find(outputKeys.knowledgeBucket(agent));
  if (bucket === undefined) return undefined;
  return {
    bucket,
    knowledgeBaseId: outputs.get(outputKeys.knowledgeBaseId(agent)),
    dataSourceId: outputs.get(outputKeys.dataSourceId(agent)),
  };
}

interface Outputs {
  find(key: string): string | undefined;
  get(key: string): string;
}

async function stackOutputs(name: string): Promise<Outputs> {
  const { Stacks } = await new CloudFormationClient().send(
    new DescribeStacksCommand({ StackName: name }),
  );
  const outputs = new Map(
    Stacks?.[0]?.Outputs?.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );

  return {
    find: (key) => outputs.get(key),
    get: (key) => {
      const value = outputs.get(key);
      if (value === undefined) throw new Error(`${name} has no output ${key}. Is it deployed?`);
      return value;
    },
  };
}
