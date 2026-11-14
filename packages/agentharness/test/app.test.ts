import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

function roleIn(app: ReturnType<typeof createApp>): Template {
  const stack = new Stack(app, 'Test');
  new Role(stack, 'Role', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  return Template.fromStack(stack);
}

describe('createApp', () => {
  it('tags every resource with the project name', () => {
    roleIn(createApp()).hasResourceProperties('AWS::IAM::Role', {
      Tags: Match.arrayWith([{ Key: 'project', Value: 'agentharness' }]),
    });
  });

  it('applies the permissions boundary to every role when one is given', () => {
    roleIn(createApp({ permissionsBoundary: 'my-boundary' })).hasResourceProperties(
      'AWS::IAM::Role',
      { PermissionsBoundary: Match.anyValue() },
    );
  });

  it('adds no permissions boundary by default', () => {
    const role = Object.values(roleIn(createApp()).findResources('AWS::IAM::Role'))[0];
    expect(role?.['Properties']).not.toHaveProperty('PermissionsBoundary');
  });
});
