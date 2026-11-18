// Records the raw InvokeHarness event stream for one message, one event per line,
// so reply.ts can be tested against what AgentCore really sends.
//
//   pnpm --dir tools/smoke record <agent> <out.jsonl> "<message>"
//
// Calls the Harness directly as the signed-in maintainer (SigV4), not through the
// front door, because the front door discards the events we want to see.
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { findStage } from './stage.ts';

const [agent, out, message] = process.argv.slice(2);
if (agent === undefined || out === undefined || message === undefined) {
  console.error('Usage: record <agent> <out.jsonl> "<message>"');
  process.exit(1);
}

const stage = await findStage(process.env['STAGE'] ?? 'dev');
const { stream } = await new BedrockAgentCoreClient().send(
  new InvokeHarnessCommand({
    harnessArn: stage.harnessArn(agent),
    runtimeSessionId: randomUUID(),
    messages: [{ role: 'user', content: [{ text: message }] }],
  }),
);
if (stream === undefined) throw new Error('The Harness returned no stream');

const lines: string[] = [];
for await (const event of stream) lines.push(JSON.stringify(event));
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`Wrote ${String(lines.length)} events to ${out}`);
