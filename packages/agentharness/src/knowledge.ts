import { Aws, RemovalPolicy, Validations } from 'aws-cdk-lib';
import { CfnDataSource, CfnKnowledgeBase } from 'aws-cdk-lib/aws-bedrock';
import { CfnGateway, CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { fromThisAccount, serviceRole } from './iam.js';

export interface KnowledgeProps {
  readonly name: string;
}

export class Knowledge extends Construct {
  readonly bucket: Bucket;
  readonly knowledgeBase: CfnKnowledgeBase;
  readonly dataSource: CfnDataSource;
  readonly gateway: CfnGateway;

  constructor(scope: Construct, id: string, { name }: KnowledgeProps) {
    super(scope, id);

    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    Validations.of(this.bucket).acknowledge({
      id: 'AwsSolutions::AwsSolutions-S1',
      reason: 'The bucket mirrors files reviewed in git; agentharness sync is its only writer.',
    });

    const knowledgeBaseRole = serviceRole(
      this,
      'KnowledgeBaseRole',
      fromThisAccount('bedrock.amazonaws.com'),
      [
        {
          why: 'Read the documents to ingest.',
          actions: ['s3:ListBucket'],
          resources: [this.bucket.bucketArn],
        },
        {
          why: 'Read any document in the bucket; sync decides what is there.',
          actions: ['s3:GetObject'],
          resources: [this.bucket.arnForObjects('*')],
        },
      ],
    );

    this.knowledgeBase = new CfnKnowledgeBase(this, 'KnowledgeBase', {
      name,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: { embeddingModelType: 'MANAGED' },
      },
    });

    this.dataSource = new CfnDataSource(this, 'DataSource', {
      name: 'knowledge',
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: 'S3',
            version: '1',
            connectionConfiguration: {
              bucketName: this.bucket.bucketName,
              bucketOwnerAccountId: Aws.ACCOUNT_ID,
            },
          },
          deletionProtectionConfiguration: { deletionProtectionStatus: 'DISABLED' },
        },
      },
    });

    const gatewayRole = serviceRole(
      this,
      'GatewayRole',
      fromThisAccount('bedrock-agentcore.amazonaws.com'),
      [
        {
          why: 'Search this agent’s knowledge base, and no other.',
          actions: ['bedrock:GetKnowledgeBase', 'bedrock:Retrieve'],
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        },
      ],
    );

    this.gateway = new CfnGateway(this, 'Gateway', {
      name,
      roleArn: gatewayRole.roleArn,
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
    });

    new CfnGatewayTarget(this, 'Target', {
      name: 'knowledge',
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'bedrock-knowledge-bases' },
            configurations: [
              {
                name: 'Retrieve',
                parameterValues: { knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId },
              },
            ],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
  }
}
