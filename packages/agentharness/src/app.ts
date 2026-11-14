import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

export function createApp(): App {
  const app = new App();
  Tags.of(app).add('project', 'agentharness');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}
