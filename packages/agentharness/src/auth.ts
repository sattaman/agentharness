import { CfnResource, Duration, Validations } from 'aws-cdk-lib';
import type { CfnHarness } from 'aws-cdk-lib/aws-bedrockagentcore';
import {
  OAuthScope,
  ResourceServerScope,
  UserPool,
  type UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

const resourceServerId = 'agentharness';
const invokeScope = 'invoke';

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;

  constructor(scope: Construct, id: string) {
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

    const invoke = new ResourceServerScope({
      scopeName: invokeScope,
      scopeDescription: 'Call agents',
    });
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: resourceServerId,
      scopes: [invoke],
    });

    this.client = this.userPool.addClient('Client', {
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [OAuthScope.resourceServer(resourceServer, invoke)],
      },
      accessTokenValidity: Duration.hours(1),
    });
    allowClientTokenAuthOnly(this.client);

    Validations.of(this.userPool).acknowledge(
      {
        id: 'AwsSolutions::AwsSolutions-COG2',
        reason:
          'The only client uses ALLOW_CLIENT_TOKEN_AUTH, which cannot sign users in, so there is no sign-in for MFA to protect.',
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

  get jwtAuthorizer(): CfnHarness.CustomJWTAuthorizerConfigurationProperty {
    return {
      discoveryUrl: `${this.userPool.userPoolProviderUrl}/.well-known/openid-configuration`,
      allowedClients: [this.client.userPoolClientId],
      allowedScopes: [`${resourceServerId}/${invokeScope}`],
    };
  }
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
