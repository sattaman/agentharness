import { Aws, Stack, Validations } from 'aws-cdk-lib';
import {
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
  type PolicyStatementProps,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { z } from 'zod';

export interface Permission extends PolicyStatementProps {
  readonly why: string;
  readonly resources: string[];
}

export const arn = (service: string, resource: string): string =>
  `arn:aws:${service}:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;

export const fromThisAccount = (service: string): ServicePrincipal =>
  new ServicePrincipal(service, {
    conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
  });

export function serviceRole(
  scope: Construct,
  id: string,
  assumedBy: ServicePrincipal,
  permissions: readonly Permission[],
): Role {
  const role = new Role(scope, id, {
    assumedBy,
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
          id: `AwsSolutions::AwsSolutions-IAM5[Resource::${asFinding(Stack.of(role).resolve(resource))}]`,
          reason: why,
        })),
    ),
  );
  return role;
}

const intrinsic = z.union([
  z.string(),
  z.strictObject({ Ref: z.string() }),
  z.strictObject({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
  z.strictObject({ 'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown())]) }),
]);

function asFinding(resolved: unknown): string {
  const value = intrinsic.parse(resolved);
  if (typeof value === 'string') return value;
  if ('Ref' in value) return `<${value.Ref}>`;
  if ('Fn::GetAtt' in value) return `<${value['Fn::GetAtt'].join('.')}>`;
  return value['Fn::Join'][1].map(asFinding).join('');
}
