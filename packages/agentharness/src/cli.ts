#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { chat } from './chat.js';
import { loadAgents } from './load.js';
import { stageSchema } from './schema.js';
import { sync } from './sync.js';
import { issueToken } from './token.js';

const usage = `Usage:
  agentharness synth                       (run by cdk via cdk.json)
  agentharness sync [--stage dev]          upload knowledge/ folders and ingest them
  agentharness token [--stage dev]         print a bearer token (valid 1 hour)
  agentharness chat <agent> [--stage dev]  chat with a deployed agent`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { stage: { type: 'string' } },
});
const [command, agent, ...extra] = positionals;
const stage = stageSchema.parse(values.stage);
const takesAgent = command === 'chat';

if (extra.length > 0 || (agent !== undefined) !== takesAgent) {
  console.error(usage);
  process.exitCode = 1;
} else if (command === 'synth') {
  buildApp('agents').synth();
} else if (command === 'sync') {
  await sync(loadAgents('agents'), stage);
} else if (command === 'token') {
  console.log((await issueToken(stage)).token);
} else if (command === 'chat' && agent !== undefined) {
  await chat(agent, stage);
} else {
  console.error(usage);
  process.exitCode = 1;
}
