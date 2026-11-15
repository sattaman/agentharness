import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  GetClientTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { outputKeys, stackNames } from 'agentharness';

const cloudformation = new CloudFormationClient();
const cognito = new CognitoIdentityProviderClient();

export interface Stage {
  readonly name: string;
  readonly apiUrl: string;
  readonly ledgerTable: string;
  harnessArn(agent: string): string;
  executionRoleName(agent: string): Promise<string>;
  token(caller: string): Promise<string>;
}

export async function findStage(name: string): Promise<Stage> {
  const auth = await outputs(stackNames.auth(name));
  const agents = await outputs(stackNames.agents(name));
  const userPoolId = auth(outputKeys.userPoolId);

  return {
    name,
    apiUrl: auth(outputKeys.apiUrl),
    ledgerTable: auth(outputKeys.ledgerTable),
    harnessArn: (agent) => agents(outputKeys.harnessArn(agent)),
    executionRoleName: async (agent) => {
      const { StackResources } = await cloudformation.send(
        new DescribeStackResourcesCommand({ StackName: stackNames.agents(name) }),
      );
      const role = StackResources?.find(
        ({ ResourceType, LogicalResourceId }) =>
          ResourceType === 'AWS::IAM::Role' &&
          LogicalResourceId?.startsWith(`${agent}ExecutionRole`) === true,
      );
      if (role?.PhysicalResourceId === undefined) throw new Error(`No execution role for ${agent}`);
      return role.PhysicalResourceId;
    },
    token: async (caller) => {
      const clientId = auth(outputKeys.clientId(caller));
      const { UserPoolClient } = await cognito.send(
        new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
      );
      const { ClientAuthenticationResult } = await cognito.send(
        new GetClientTokenCommand({ ClientId: clientId, Secret: UserPoolClient?.ClientSecret }),
      );
      const token = ClientAuthenticationResult?.AccessToken;
      if (token === undefined) throw new Error(`Cognito issued no token for ${caller}`);
      return token;
    },
  };
}

async function outputs(stack: string): Promise<(key: string) => string> {
  const { Stacks } = await cloudformation.send(new DescribeStacksCommand({ StackName: stack }));
  const values = new Map(Stacks?.[0]?.Outputs?.map((o) => [o.OutputKey, o.OutputValue]));
  return (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`${stack} has no output ${key}. Is it deployed?`);
    return value;
  };
}
