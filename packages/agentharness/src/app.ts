import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

export interface AppOptions {
  readonly permissionsBoundary?: string;
}

export function createApp(options: AppOptions = {}): App {
  const context =
    options.permissionsBoundary === undefined
      ? {}
      : { '@aws-cdk/core:permissionsBoundary': { name: options.permissionsBoundary } };

  const app = new App({ context });
  Tags.of(app).add('project', 'agentharness');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}
