import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type InvokeHarnessCommandInput,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { findHarnessArn } from './deployment.js';
import { reserve, settle } from './ledger.js';
import { repliesFrom, type Reply } from './reply.js';
import type { Grants } from './request.js';
import { agentConfigSchema } from './schema.js';
import { serve, type FrontDoor, type Writer } from './serve.js';

interface ResponseMetadata {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}

declare global {
  const awslambda: {
    streamifyResponse(handler: (event: unknown, stream: Writable) => Promise<void>): unknown;
    HttpResponseStream: { from(stream: Writable, metadata: ResponseMetadata): Writable };
  };
}

const env = z
  .object({ STAGE: z.string(), GRANTS: z.string(), AGENTS: z.string(), LEDGER: z.string() })
  .parse(process.env);
const grants: Grants = new Map(
  z
    .array(
      z.tuple([
        z.string(),
        z.strictObject({ caller: z.string(), agents: z.array(z.string()), budgetMicros: z.int() }),
      ]),
    )
    .parse(JSON.parse(env.GRANTS)),
);
const limits = z
  .record(z.string(), agentConfigSchema.pick({ model: true, maxTokens: true, maxIterations: true }))
  .parse(JSON.parse(env.AGENTS));
const harnesses = new Map<string, { readonly arn: string; readonly at: number }>();
const cacheMs = 60_000;
const agentcore = new BedrockAgentCoreClient();

const eventSchema = z.object({
  body: z.string().nullable(),
  requestContext: z.object({
    requestId: z.string(),
    authorizer: z.object({ claims: z.object({ client_id: z.string(), scope: z.string() }) }),
  }),
});

const door: Omit<FrontDoor, 'open'> = {
  grants,
  limits,
  findHarness,
  invoke,
  reserve: (key, micros, budgetMicros, ledgerId) =>
    reserve(env.LEDGER, key, micros, budgetMicros, ledgerId),
  settle: (key, deltaMicros, ledgerId) => settle(env.LEDGER, key, deltaMicros, ledgerId),
  now: () => new Date(),
  newId: randomUUID,
  error: (error) => {
    console.error(error);
  },
};

export const handler = awslambda.streamifyResponse(async (raw, responseStream) => {
  const { body, requestContext } = eventSchema.parse(raw);
  const { client_id: clientId, scope } = requestContext.authorizer.claims;
  const summary = await serve(
    { requestId: requestContext.requestId, clientId, scope, body },
    { ...door, open: (statusCode, contentType) => writer(responseStream, statusCode, contentType) },
  );
  console.log(JSON.stringify(summary));
});

async function* invoke(input: InvokeHarnessCommandInput): AsyncGenerator<Reply> {
  const { stream } = await agentcore.send(new InvokeHarnessCommand(input));
  if (stream === undefined) throw new Error('The harness returned no response stream');
  yield* repliesFrom(stream);
}

async function findHarness(agent: string): Promise<string | undefined> {
  const cached = harnesses.get(agent);
  if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.arn;
  try {
    const arn = await findHarnessArn(env.STAGE, agent);
    harnesses.set(agent, { arn, at: Date.now() });
    return arn;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

function writer(responseStream: Writable, statusCode: number, contentType: string): Writer {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { 'content-type': contentType },
  });
  return {
    write: async (text) => {
      try {
        await write(stream, text);
        return true;
      } catch (error) {
        console.error(error);
        return false;
      }
    },
    end: async () => {
      if (stream.destroyed) return;
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}

async function write(stream: Writable, text: string): Promise<void> {
  if (stream.destroyed) throw new Error('The caller has disconnected');
  if (stream.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error): void => {
      stream.off('drain', onDrain).off('close', onClose).off('error', done);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => {
      done();
    };
    const onClose = (): void => {
      done(new Error('The caller has disconnected'));
    };
    stream.once('drain', onDrain).once('close', onClose).once('error', done);
  });
}
