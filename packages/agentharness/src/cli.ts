#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { chat } from './chat.js';
import { stageSchema } from './schema.js';
import { issueToken } from './token.js';

const usage = `Usage:
  agentharness synth                       (run by cdk via cdk.json)
  agentharness token [--stage dev]         print a bearer token (valid 1 hour)
  agentharness chat <agent> [--stage dev]  chat with a deployed agent`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { stage: { type: 'string' } },
});
const [command, agent] = positionals;
const stage = stageSchema.parse(values.stage);

if (command === 'synth') {
  buildApp('agents').synth();
} else if (command === 'token') {
  console.log((await issueToken(stage)).token);
} else if (command === 'chat' && agent !== undefined) {
  await chat(agent, stage);
} else {
  console.error(usage);
  process.exitCode = 1;
}
