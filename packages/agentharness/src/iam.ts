import { Aws, Validations } from 'aws-cdk-lib';
import {
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
  type PolicyStatementProps,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface Permission extends PolicyStatementProps {
  readonly why: string;
  readonly resources: string[];
}

export const arn = (service: string, resource: string): string =>
  `arn:aws:${service}:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;

export function serviceRole(
  scope: Construct,
  id: string,
  service: string,
  permissions: readonly Permission[],
): Role {
  const role = new Role(scope, id, {
    assumedBy: new ServicePrincipal(service, {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
    }),
    inlinePolicies: {
      permissions: new PolicyDocument({
        statements: permissions.map((permission) => new PolicyStatement(permission)),
      }),
    },
  });

  Validations.of(role).acknowledge(
    ...permissions.flatMap(({ why, resources }) =>
      resources
        .filter((resource) => resource.includes('*'))
        .map((resource) => ({
          id: `AwsSolutions::AwsSolutions-IAM5[Resource::${asFinding(resource)}]`,
          reason: why,
        })),
    ),
  );
  return role;
}

const asFinding = (resource: string): string =>
  resource.replaceAll(Aws.REGION, '<AWS::Region>').replaceAll(Aws.ACCOUNT_ID, '<AWS::AccountId>');
