#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { init } from './init.js';
import { loadAgents } from './load.js';
import { stageSchema } from './schema.js';
import { sync } from './sync.js';

const usage = `Usage:
  agentharness init <dir>           create a starter repo with one agent
  agentharness synth                (run by cdk via cdk.json)
  agentharness sync [--stage dev]   upload knowledge/ folders and ingest them`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { stage: { type: 'string' } },
});
const [command, target, ...extra] = positionals;
const stage = stageSchema.parse(values.stage);

if (extra.length > 0 || (target !== undefined) !== (command === 'init')) {
  console.error(usage);
  process.exitCode = 1;
} else if (command === 'init' && target !== undefined) {
  init(target);
  console.log(`Created ${target}. Next:

  cd ${target}
  npm install
  npx cdk bootstrap      # once per AWS account and region
  npm run deploy

Then follow README.md to call your agent.`);
} else if (command === 'synth') {
  buildApp('agents').synth();
} else if (command === 'sync') {
  await sync(loadAgents('agents'), stage);
} else {
  console.error(usage);
  process.exitCode = 1;
}
