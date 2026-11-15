import type { InvokeHarnessCommandInput } from '@aws-sdk/client-bedrock-agentcore';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nameSchema } from './schema.js';

export const resourceServer = 'agentharness';

export const scopeFor = (agent: string): string => `${resourceServer}/${agent}`;

export const chatRequestSchema = z.strictObject({
  agent: nameSchema,
  message: z.string().min(1).max(10_000),
  sessionId: z.uuid(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface Caller {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export type Grants = ReadonlyMap<string, readonly string[]>;

export const mayCall = (caller: Caller, agent: string, grants: Grants): boolean =>
  caller.scopes.includes(scopeFor(agent)) &&
  (grants.get(caller.clientId)?.includes(agent) ?? false);

export const sessionFor = (caller: Caller, { agent, sessionId }: ChatRequest): string =>
  createHash('sha256')
    .update(JSON.stringify([caller.clientId, agent, sessionId]))
    .digest('hex');

export const invocation = (
  harnessArn: string,
  caller: Caller,
  request: ChatRequest,
): InvokeHarnessCommandInput => ({
  harnessArn,
  runtimeSessionId: sessionFor(caller, request),
  messages: [{ role: 'user', content: [{ text: request.message }] }],
});
