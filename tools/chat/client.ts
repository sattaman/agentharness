import { replySchema, type ChatRequest, type Reply } from 'agentharness/contract';

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
    throw new Error(`${String(response.status)}: ${await response.text()}`);
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
