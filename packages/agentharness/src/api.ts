import { CfnResource, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  LambdaIntegration,
  ResponseTransferMode,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { UserPool } from 'aws-cdk-lib/aws-cognito';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { arn, serviceRole } from './iam.js';
import { harnessName, stackNames } from './names.js';
import { chatRequestSchema } from './request.js';

export interface ApiProps {
  readonly stage: string;
  readonly userPool: UserPool;
  readonly scopes: readonly string[];
  /** Client ID to the agents that client may call, checked on every request. */
  readonly grants: readonly (readonly [string, readonly string[]])[];
}

const handlerCode = fileURLToPath(new URL('../dist/handler', import.meta.url));
const maxAnswer = Duration.minutes(15);

export class Api extends Construct {
  readonly url: string;

  constructor(scope: Construct, id: string, { stage, userPool, scopes, grants }: ApiProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'Logs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = serviceRole(this, 'Role', new ServicePrincipal('lambda.amazonaws.com'), [
      {
        why: 'Write its own logs.',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      },
      {
        why: 'Find each Harness ARN in the agents stack outputs. Stack ARNs end in a generated ID.',
        actions: ['cloudformation:DescribeStacks'],
        resources: [arn('cloudformation', `stack/${stackNames.agents(stage)}/*`)],
      },
      {
        why: 'Invoke this stage’s agents, and nothing else: no commands, no shells. Harness IDs are the name plus a generated suffix.',
        actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
        resources: [arn('bedrock-agentcore', `harness/${harnessName(stage, '*')}`)],
      },
    ]);

    const handler = new Function(this, 'Handler', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(handlerCode),
      role,
      logGroup,
      timeout: maxAnswer,
      memorySize: 256,
      environment: { STAGE: stage, GRANTS: Stack.of(this).toJsonString(grants) },
    });
    Validations.of(handler).acknowledge({
      id: 'AwsSolutions::AwsSolutions-L1',
      reason:
        'Node.js 24 is the newest generally available Lambda runtime; nodejs26.x is in preview (D10).',
    });

    const api = new RestApi(this, 'Api', {
      restApiName: `agentharness-${stage}`,
      description: 'The only way in to agentharness agents.',
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      cloudWatchRole: false,
      deployOptions: { stageName: 'v1', throttlingRateLimit: 5, throttlingBurstLimit: 10 },
    });
    this.url = api.url;

    const model = api.addModel('ChatRequest', { contentType: 'application/json', schema: {} });
    const modelResource = model.node.defaultChild;
    if (!CfnResource.isCfnResource(modelResource)) throw new Error('Model has no resource');
    modelResource.addPropertyOverride(
      'Schema',
      z.toJSONSchema(chatRequestSchema, { target: 'draft-4' }),
    );

    api.root.addResource('chat').addMethod(
      'POST',
      new LambdaIntegration(handler, {
        responseTransferMode: ResponseTransferMode.STREAM,
        timeout: maxAnswer,
      }),
      {
        authorizationType: AuthorizationType.COGNITO,
        authorizer: new CognitoUserPoolsAuthorizer(this, 'Authorizer', {
          cognitoUserPools: [userPool],
        }),
        authorizationScopes: [...scopes],
        requestValidator: api.addRequestValidator('Request', {
          validateRequestBody: true,
          validateRequestParameters: true,
        }),
        requestModels: { 'application/json': model },
      },
    );

    Validations.of(api).acknowledge(
      {
        id: 'AwsSolutions::AwsSolutions-APIG1',
        reason:
          'The handler logs every request (caller, agent, outcome, tokens); API Gateway logging needs an account-wide role the kit does not own.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-APIG6',
        reason: 'As APIG1: the handler logs every request.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-APIG3',
        reason:
          'Cognito scopes, request validation and stage throttling guard the API; WAF is recorded as a later step.',
      },
    );
  }
}
