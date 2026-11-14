import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadAgents } from './load.js';
import { stageSchema } from './schema.js';
import { AgentHarnessStack } from './stack.js';

export function createApp(): App {
  const app = new App();
  Tags.of(app).add('project', 'agentharness');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

export function buildApp(agentsDir: string): App {
  const app = createApp();
  const stage = stageSchema.parse(app.node.tryGetContext('stage'));
  new AgentHarnessStack(app, { stage, agents: loadAgents(agentsDir) });
  return app;
}
