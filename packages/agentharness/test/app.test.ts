import { Stack, type App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

function roleIn(app: App): Template {
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

  it('honours the standard CDK permissions boundary context', () => {
    const app = createApp();
    app.node.setContext('@aws-cdk/core:permissionsBoundary', { name: 'my-boundary' });
    roleIn(app).hasResourceProperties('AWS::IAM::Role', { PermissionsBoundary: Match.anyValue() });
  });

  it('adds no permissions boundary by default', () => {
    const role = Object.values(roleIn(createApp()).findResources('AWS::IAM::Role'))[0];
    expect(role?.['Properties']).not.toHaveProperty('PermissionsBoundary');
  });
});
