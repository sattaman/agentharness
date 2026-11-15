#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { loadAgents } from './load.js';
import { stageSchema } from './schema.js';
import { sync } from './sync.js';

const usage = `Usage:
  agentharness synth                (run by cdk via cdk.json)
  agentharness sync [--stage dev]   upload knowledge/ folders and ingest them`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { stage: { type: 'string' } },
});
const [command, ...extra] = positionals;
const stage = stageSchema.parse(values.stage);

if (extra.length > 0) {
  console.error(usage);
  process.exitCode = 1;
} else if (command === 'synth') {
  buildApp('agents').synth();
} else if (command === 'sync') {
  await sync(loadAgents('agents'), stage);
} else {
  console.error(usage);
  process.exitCode = 1;
}
