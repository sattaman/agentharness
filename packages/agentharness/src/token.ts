import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  GetClientTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { TokenIdentity, TokenIdentityProvider } from '@smithy/types';
import { findCredentials } from './deployment.js';

const refreshMargin = 60_000;

export async function issueToken(stage: string): Promise<TokenIdentity> {
  const { userPoolId, clientId } = await findCredentials(stage);
  const cognito = new CognitoIdentityProviderClient();

  const { UserPoolClient } = await cognito.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
  );
  const secret = UserPoolClient?.ClientSecret;
  if (secret === undefined) throw new Error('The app client has no secret');

  const { ClientAuthenticationResult: result } = await cognito.send(
    new GetClientTokenCommand({ ClientId: clientId, Secret: secret }),
  );
  if (result?.AccessToken === undefined || result.ExpiresIn === undefined) {
    throw new Error('Cognito did not return an access token');
  }
  return { token: result.AccessToken, expiration: new Date(Date.now() + result.ExpiresIn * 1000) };
}

export function tokenProvider(stage: string): TokenIdentityProvider {
  let current: TokenIdentity | undefined;
  return async () => {
    const expiresSoon = (current?.expiration?.getTime() ?? 0) - Date.now() < refreshMargin;
    if (current === undefined || expiresSoon) current = await issueToken(stage);
    return current;
  };
}
