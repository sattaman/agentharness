import { Aws, RemovalPolicy, Validations } from 'aws-cdk-lib';
import { CfnDataSource, CfnKnowledgeBase } from 'aws-cdk-lib/aws-bedrock';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { GatewayTool } from './gateway.js';
import { fromThisAccount, serviceRole } from './iam.js';

export interface KnowledgeProps {
  readonly name: string;
}

export class Knowledge extends Construct {
  readonly bucket: Bucket;
  readonly knowledgeBase: CfnKnowledgeBase;
  readonly dataSource: CfnDataSource;
  /** The Gateway target that lets the agent search this knowledge base. */
  readonly tool: GatewayTool;

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

    this.tool = {
      name: 'knowledge',
      tools: ['Retrieve'],
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
      permissions: [
        {
          why: 'Search this agent’s knowledge base, and no other.',
          actions: ['bedrock:GetKnowledgeBase', 'bedrock:Retrieve'],
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        },
      ],
    };
  }
}
