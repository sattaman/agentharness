import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { findHarnessArn } from './deployment.js';
import { repliesFrom, type Reply } from './reply.js';
import { chatRequestSchema, invocation, mayCall, type Caller, type Grants } from './request.js';

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

const env = z.object({ STAGE: z.string(), GRANTS: z.string() }).parse(process.env);
const grants: Grants = new Map(
  z.array(z.tuple([z.string(), z.array(z.string())])).parse(JSON.parse(env.GRANTS)),
);
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

export const handler = awslambda.streamifyResponse(async (raw, responseStream) => {
  const { body, requestContext } = eventSchema.parse(raw);
  const { client_id: clientId, scope } = requestContext.authorizer.claims;
  const caller: Caller = { clientId, scopes: scope.split(' ') };
  const log = { requestId: requestContext.requestId, clientId, agent: '', outcome: 'ok' };
  const usage = { inputTokens: 0, outputTokens: 0 };

  const reject = async (statusCode: number, message: string): Promise<void> => {
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { 'content-type': 'application/json' },
    });
    await write(out, JSON.stringify({ message }));
    await finish(out);
    console.log(JSON.stringify({ ...log, outcome: `rejected ${String(statusCode)}` }));
  };

  if (!grants.has(clientId)) return reject(403, 'Unknown caller');
  const request = chatRequestSchema.safeParse(parseJson(body));
  if (!request.success) return reject(400, 'Send {"agent", "message", "sessionId"}');
  log.agent = request.data.agent;
  if (!mayCall(caller, request.data.agent, grants))
    return reject(403, 'Not allowed to call this agent');
  const harnessArn = await lookup(request.data.agent);
  if (harnessArn === undefined) return reject(404, 'No such agent is deployed');

  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
  try {
    const { stream } = await agentcore.send(
      new InvokeHarnessCommand(invocation(harnessArn, caller, request.data)),
    );
    if (stream === undefined) throw new Error('The harness returned no response stream');
    for await (const reply of repliesFrom(stream)) {
      if (reply.type === 'usage') {
        usage.inputTokens += reply.inputTokens;
        usage.outputTokens += reply.outputTokens;
      }
      await send(out, reply);
    }
  } catch (error) {
    log.outcome = 'failed';
    console.error(error);
    await send(out, { type: 'error', message: 'The agent failed. Try again.' });
  } finally {
    await finish(out);
    console.log(JSON.stringify({ ...log, ...usage }));
  }
});

async function lookup(agent: string): Promise<string | undefined> {
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

function parseJson(body: string | null): unknown {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
}

const send = (stream: Writable, reply: Reply): Promise<void> =>
  write(stream, `${JSON.stringify(reply)}\n`);

async function write(stream: Writable, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain');
}

async function finish(stream: Writable): Promise<void> {
  await new Promise<void>((resolve) => stream.end(resolve));
}
