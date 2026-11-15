import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { dirname, join, resolve } from 'node:path';
import { loadAgents, loadCallers } from './load.js';
import { stageSchema } from './schema.js';
import { AgentsStack, AuthStack } from './stack.js';

export function createApp(): App {
  const app = new App();
  Tags.of(app).add('project', 'agentharness');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

export function buildApp(agentsDir: string): App {
  const app = createApp();
  const stage = stageSchema.parse(app.node.tryGetContext('stage'));
  const agents = loadAgents(agentsDir);
  const callers = loadCallers(join(dirname(resolve(agentsDir)), 'callers.json'), agents);
  new AuthStack(app, { stage, agents, callers });
  new AgentsStack(app, { stage, agents });
  return app;
}
