import { CfnResource, Duration, Validations } from 'aws-cdk-lib';
import {
  OAuthScope,
  ResourceServerScope,
  UserPool,
  type UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import type { AgentSpec } from './load.js';
import { maintainers } from './names.js';
import { resourceServer, scopeFor } from './request.js';

export interface AuthProps {
  readonly agents: readonly AgentSpec[];
}

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly clients: ReadonlyMap<string, { client: UserPoolClient; agents: readonly string[] }>;
  readonly scopes: readonly string[];

  constructor(scope: Construct, id: string, { agents }: AuthProps) {
    super(scope, id);

    this.userPool = new UserPool(this, 'Pool', {
      selfSignUpEnabled: false,
      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
    });

    const agentScopes = new Map(
      agents.map(({ name }) => [
        name,
        new ResourceServerScope({ scopeName: name, scopeDescription: `Call ${name}` }),
      ]),
    );
    const server = this.userPool.addResourceServer('ResourceServer', {
      identifier: resourceServer,
      scopes: [...agentScopes.values()],
    });
    this.scopes = agents.map(({ name }) => scopeFor(name));

    const clients = new Map<string, { client: UserPoolClient; agents: readonly string[] }>();
    for (const [caller, agentNames] of callersOf(agents)) {
      const client = this.userPool.addClient(caller, {
        userPoolClientName: caller,
        generateSecret: true,
        oAuth: {
          flows: { clientCredentials: true },
          scopes: agentNames.flatMap((name) => {
            const agentScope = agentScopes.get(name);
            return agentScope ? [OAuthScope.resourceServer(server, agentScope)] : [];
          }),
        },
        accessTokenValidity: Duration.hours(1),
      });
      allowClientTokenAuthOnly(client);
      clients.set(caller, { client, agents: agentNames });
    }
    this.clients = clients;

    Validations.of(this.userPool).acknowledge(
      {
        id: 'AwsSolutions::AwsSolutions-COG2',
        reason:
          'Every client uses ALLOW_CLIENT_TOKEN_AUTH, which cannot sign users in, so there is no sign-in for MFA to protect.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-COG3',
        reason: 'Threat protection inspects user sign-ins, which the client-token flow rules out.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-COG8',
        reason:
          'The Plus plan adds user sign-in protections; this pool only issues machine tokens.',
      },
    );
  }
}

function callersOf(agents: readonly AgentSpec[]): Map<string, string[]> {
  const callers = new Map([[maintainers, agents.map(({ name }) => name)]]);
  for (const { name, config } of agents) {
    for (const caller of config.callers) {
      const allowed = callers.get(caller) ?? [];
      if (!allowed.includes(name)) allowed.push(name);
      callers.set(caller, allowed);
    }
  }
  return callers;
}

function allowClientTokenAuthOnly(client: UserPoolClient): void {
  const resource = client.node.defaultChild;
  if (!CfnResource.isCfnResource(resource))
    throw new Error('UserPoolClient has no CloudFormation resource');

  resource.addPropertyOverride('ExplicitAuthFlows', ['ALLOW_CLIENT_TOKEN_AUTH']);
  Validations.of(resource).acknowledge({
    id: 'CloudFormation-Validate::W3030',
    reason:
      'The bundled schema predates ALLOW_CLIENT_TOKEN_AUTH (Cognito GetClientToken, August 2026).',
  });
}
