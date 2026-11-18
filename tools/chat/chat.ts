import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Reply } from 'agentharness/contract';
import { ask } from './client.ts';

const [agent] = process.argv.slice(2);
const apiUrl = process.env['AGENTHARNESS_API_URL'] ?? '';
const token = process.env['AGENTHARNESS_TOKEN'] ?? '';

if (agent === undefined || apiUrl === '' || token === '') {
  console.error('Usage: AGENTHARNESS_API_URL=… AGENTHARNESS_TOKEN=… pnpm chat <agent>');
  process.exit(1);
}

const sessionId = randomUUID();
const input = createInterface({ input: process.stdin });
const prompt = (): boolean => process.stdout.write('\n> ');

console.log(`Chatting with ${agent}. Empty line to quit.`);
prompt();
for await (const line of input) {
  const message = line.trim();
  if (message === '') break;
  try {
    for await (const reply of ask(apiUrl, token, { agent, message, sessionId })) show(reply);
  } catch (error) {
    console.log(`\n[${error instanceof Error ? error.message : String(error)}]`);
  }
  prompt();
}
input.close();

function show(reply: Reply): void {
  switch (reply.type) {
    case 'text':
      process.stdout.write(reply.text);
      return;
    case 'tool':
      console.log(`\n[using ${reply.name}]`);
      return;
    case 'toolInput':
      return;
    case 'toolResult':
      console.log(`[tool ${reply.status}]`);
      return;
    case 'stopped':
      console.log(`\n[stopped: ${reply.reason}]`);
      return;
    case 'usage':
      console.log(`\n[${String(reply.inputTokens)} in / ${String(reply.outputTokens)} out tokens]`);
      return;
    case 'error':
      console.log(`\n[error: ${reply.message}]`);
      return;
  }
}
