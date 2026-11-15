import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { findAccess } from './deployment.js';
import { maintainers } from './names.js';
import { replySchema, type Reply } from './reply.js';
import type { ChatRequest } from './request.js';
import { tokenProvider } from './token.js';

export async function* ask(
  apiUrl: string,
  token: string,
  request: ChatRequest,
): AsyncGenerator<Reply> {
  const response = await fetch(new URL('chat', apiUrl), {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`The front door said ${String(response.status)}: ${await response.text()}`);
  }
  for await (const line of lines(response.body)) yield replySchema.parse(JSON.parse(line));
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    const parts = (buffer + chunk).split('\n');
    buffer = parts.pop() ?? '';
    yield* parts.filter((part) => part !== '');
  }
  if (buffer !== '') yield buffer;
}

export async function chat(agent: string, stage: string, caller = maintainers): Promise<void> {
  const access = await findAccess(stage, caller);
  const token = tokenProvider(access);
  const sessionId = randomUUID();
  const lines = createInterface({ input: process.stdin });
  const prompt = (): boolean => process.stdout.write('\n> ');

  try {
    console.log(`Chatting with ${agent} (${stage}) as ${caller}. Empty line to quit.`);
    prompt();
    for await (const line of lines) {
      const message = line.trim();
      if (message === '') break;
      try {
        for await (const reply of ask(access.apiUrl, await token(), {
          agent,
          message,
          sessionId,
        })) {
          show(reply);
        }
      } catch (error) {
        console.log(`\n[${error instanceof Error ? error.message : String(error)}]`);
      }
      prompt();
    }
  } finally {
    lines.close();
  }
}

function show(reply: Reply): void {
  switch (reply.type) {
    case 'text':
      process.stdout.write(reply.text);
      return;
    case 'tool':
      console.log(`\n[using ${reply.name}]`);
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
