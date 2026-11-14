import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadAgents } from './load.js';
import { stageSchema } from './schema.js';
import { AgentsStack, AuthStack } from './stack.js';

export function createApp(): App {
  const app = new App({ context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong' } });
  Tags.of(app).add('project', 'agentharness');
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

export function buildApp(agentsDir: string): App {
  const app = createApp();
  const stage = stageSchema.parse(app.node.tryGetContext('stage'));
  const { auth } = new AuthStack(app, { stage });
  new AgentsStack(app, { stage, auth, agents: loadAgents(agentsDir) });
  return app;
}
