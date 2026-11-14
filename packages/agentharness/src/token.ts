import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';
import { requireOutput, stackOutputs } from './outputs.js';

const username = 'cli';

export async function issueToken(stage: string): Promise<string> {
  const outputs = await stackOutputs(stage);
  const userPoolId = requireOutput(outputs, 'UserPoolId');
  const clientId = requireOutput(outputs, 'UserPoolClientId');
  const cognito = new CognitoIdentityProviderClient({});
  const password = `${randomBytes(24).toString('base64url')}aA1!`;

  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        MessageAction: 'SUPPRESS',
      }),
    );
  } catch (error) {
    if (!(error instanceof UsernameExistsException)) throw error;
  }
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );

  const { AuthenticationResult } = await cognito.send(
    new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const token = AuthenticationResult?.AccessToken;
  if (token === undefined) throw new Error('Cognito did not return an access token');
  return token;
}
