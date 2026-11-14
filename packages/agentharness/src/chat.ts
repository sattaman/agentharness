import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { FinalizeRequestMiddleware, MetadataBearer } from '@smithy/types';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { requireOutput, stackOutputs } from './outputs.js';
import { issueToken } from './token.js';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function bearerClient(token: string): BedrockAgentCoreClient {
  const client = new BedrockAgentCoreClient({
    credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' },
  });
  const useBearerToken: FinalizeRequestMiddleware<object, MetadataBearer> = (next) => (args) => {
    if (hasHeaders(args.request)) args.request.headers['authorization'] = `Bearer ${token}`;
    return next(args);
  };
  client.middlewareStack.addRelativeTo(useBearerToken, {
    relation: 'after',
    toMiddleware: 'httpSigningMiddleware',
    name: 'bearerTokenMiddleware',
  });
  return client;
}

function hasHeaders(request: unknown): request is { headers: Record<string, string> } {
  return typeof request === 'object' && request !== null && 'headers' in request;
}

export async function ask(
  client: BedrockAgentCoreClient,
  harnessArn: string,
  sessionId: string,
  text: string,
  onText: (chunk: string) => void,
): Promise<Usage | undefined> {
  const { stream } = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: sessionId,
      messages: [{ role: 'user', content: [{ text }] }],
    }),
  );
  if (stream === undefined) throw new Error('The harness returned no response stream');
  let usage: Usage | undefined;
  for await (const event of stream) {
    const chunk = event.contentBlockDelta?.delta?.text;
    if (chunk !== undefined) onText(chunk);
    const tokens = event.metadata?.usage;
    if (tokens)
      usage = { inputTokens: tokens.inputTokens ?? 0, outputTokens: tokens.outputTokens ?? 0 };
    const error =
      event.runtimeClientError ?? event.validationException ?? event.internalServerException;
    if (error) throw new Error(error.message);
  }
  return usage;
}

export async function chat(agent: string, stage: string): Promise<void> {
  const harnessArn = requireOutput(await stackOutputs(stage), `${agent}HarnessArn`);
  const client = bearerClient(await issueToken(stage));
  const sessionId = randomUUID();
  const lines = createInterface({ input: process.stdin });
  const prompt = (): boolean => process.stdout.write('\n> ');
  console.log(`Chatting with ${agent} (${stage}). Empty line to quit.`);

  prompt();
  for await (const line of lines) {
    const question = line.trim();
    if (question === '') break;
    const usage = await ask(client, harnessArn, sessionId, question, (chunk) =>
      process.stdout.write(chunk),
    );
    if (usage)
      console.log(`\n[${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out tokens]`);
    prompt();
  }
  lines.close();
}
