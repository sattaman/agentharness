import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import {
  AccountRecovery,
  FeaturePlan,
  UserPool,
  type UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;
  readonly discoveryUrl: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new UserPool(this, 'Users', {
      featurePlan: FeaturePlan.LITE,
      selfSignUpEnabled: false,
      accountRecovery: AccountRecovery.NONE,
      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.client = this.userPool.addClient('Client', {
      authFlows: { userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
    });

    this.discoveryUrl = `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`;

    const accepted: Record<string, string> = {
      'AwsSolutions-COG2':
        'Users are created with one-off passwords by the IAM-authenticated CLI; nobody signs in interactively.',
      'AwsSolutions-COG3':
        'Threat protection needs the Plus feature plan, not justified for CLI-issued tokens.',
      'AwsSolutions-COG8': 'The Lite feature plan is enough for CLI-issued tokens.',
    };
    for (const [rule, reason] of Object.entries(accepted)) {
      Validations.of(this.userPool).acknowledge({ id: `AwsSolutions::${rule}`, reason });
    }
  }
}
