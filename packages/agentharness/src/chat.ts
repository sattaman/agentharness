import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { HttpBearerAuthSigner } from '@smithy/core';
import type { TokenIdentityProvider } from '@smithy/types';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { findHarnessArn } from './deployment.js';
import { tokenProvider } from './token.js';

export type Reply =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number };

const bearer = 'smithy.api#httpBearerAuth';

export function harnessClient(tokens: TokenIdentityProvider): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({
    httpAuthSchemeProvider: () => [{ schemeId: bearer }],
    httpAuthSchemes: [
      { schemeId: bearer, identityProvider: () => tokens, signer: new HttpBearerAuthSigner() },
    ],
  });
}

export async function* ask(
  client: BedrockAgentCoreClient,
  harnessArn: string,
  sessionId: string,
  text: string,
): AsyncGenerator<Reply> {
  const { stream } = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: sessionId,
      messages: [{ role: 'user', content: [{ text }] }],
    }),
  );
  if (stream === undefined) throw new Error('The harness returned no response stream');

  for await (const event of stream) {
    const error =
      event.runtimeClientError ?? event.validationException ?? event.internalServerException;
    if (error) throw new Error(error.message);

    const chunk = event.contentBlockDelta?.delta?.text;
    if (chunk !== undefined) yield { type: 'text', text: chunk };

    const usage = event.metadata?.usage;
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
    }
  }
}

export async function chat(agent: string, stage: string): Promise<void> {
  const harnessArn = await findHarnessArn(stage, agent);
  const client = harnessClient(tokenProvider(stage));
  const sessionId = randomUUID();
  const lines = createInterface({ input: process.stdin });
  const prompt = (): boolean => process.stdout.write('\n> ');

  try {
    console.log(`Chatting with ${agent} (${stage}). Empty line to quit.`);
    prompt();
    for await (const line of lines) {
      const question = line.trim();
      if (question === '') break;
      for await (const reply of ask(client, harnessArn, sessionId, question)) show(reply);
      prompt();
    }
  } finally {
    lines.close();
    client.destroy();
  }
}

function show(reply: Reply): void {
  switch (reply.type) {
    case 'text':
      process.stdout.write(reply.text);
      return;
    case 'usage':
      console.log(`\n[${String(reply.inputTokens)} in / ${String(reply.outputTokens)} out tokens]`);
      return;
  }
}
