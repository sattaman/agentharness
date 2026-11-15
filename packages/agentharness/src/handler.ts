import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { findHarnessArn } from './deployment.js';
import { reserve, settle } from './ledger.js';
import { repliesFrom, type Reply } from './reply.js';
import { chatRequestSchema, invocation, mayCall, type Caller, type Grants } from './request.js';
import { agentConfigSchema } from './schema.js';
import { addUsage, costMicros, ledgerKey, noUsage, reservationMicros } from './spend.js';

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

export const handler = awslambda.streamifyResponse(async (raw, responseStream) => {
  const { body, requestContext } = eventSchema.parse(raw);
  const { requestId } = requestContext;
  const { client_id: clientId, scope } = requestContext.authorizer.claims;
  const caller: Caller = { clientId, scopes: scope.split(' ') };
  const grant = grants.get(clientId);
  const ledgerId = randomUUID();
  const summary = {
    requestId,
    ledgerId,
    clientId,
    caller: grant?.caller,
    agent: '',
    outcome: 'ok',
  };

  const reject = async (statusCode: number, message: string): Promise<void> => {
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { 'content-type': 'application/json' },
    });
    await write(out, JSON.stringify({ message }));
    await finish(out);
    console.log(JSON.stringify({ ...summary, outcome: `rejected ${String(statusCode)}` }));
  };

  if (grant === undefined) return reject(403, 'Unknown caller');
  const request = chatRequestSchema.safeParse(parseJson(body));
  if (!request.success) return reject(400, 'Send {"agent", "message", "sessionId"}');
  const { agent } = request.data;
  summary.agent = agent;
  if (!mayCall(caller, agent, grants)) return reject(403, 'Not allowed to call this agent');
  const agentLimits = limits[agent];
  const harnessArn = await lookup(agent);
  if (agentLimits === undefined || harnessArn === undefined) {
    return reject(404, 'No such agent is deployed');
  }

  const reserved = reservationMicros(agentLimits);
  const key = ledgerKey(grant.caller, new Date());
  let admitted: boolean;
  try {
    admitted =
      reserved <= grant.budgetMicros &&
      (await reserve(env.LEDGER, key, reserved, grant.budgetMicros, ledgerId));
  } catch (error) {
    console.error(error);
    return reject(503, 'The budget check is unavailable. Try again later.');
  }
  if (!admitted) return reject(429, 'This caller has used its monthly budget');

  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
  let usage = noUsage;
  let metered = false;
  let complete = false;
  let delivering = true;
  try {
    const { stream } = await agentcore.send(
      new InvokeHarnessCommand(invocation(harnessArn, caller, request.data)),
    );
    if (stream === undefined) throw new Error('The harness returned no response stream');
    for await (const reply of repliesFrom(stream)) {
      if (reply.type === 'usage') {
        usage = addUsage(usage, reply);
        metered = true;
      }
      if (delivering) delivering = await deliver(out, reply);
    }
    complete = true;
  } catch (error) {
    summary.outcome = 'failed';
    console.error(error);
    if (delivering) await deliver(out, { type: 'error', message: 'The agent failed. Try again.' });
  }

  const settled = complete && metered;
  const charged = settled ? costMicros(agentLimits.model, usage) : reserved;
  let accounting = settled ? 'settled' : 'reservation kept';
  try {
    await settle(env.LEDGER, key, charged - reserved, ledgerId);
  } catch (error) {
    console.error(error);
    accounting = 'settle failed; reservation kept';
  }
  await finish(out).catch((error: unknown) => {
    console.error(error);
  });
  console.log(
    JSON.stringify({
      ...summary,
      model: agentLimits.model,
      ...usage,
      costUsd: charged / 1_000_000,
      reservedUsd: reserved / 1_000_000,
      overReservation: charged > reserved,
      accounting,
    }),
  );
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

async function deliver(stream: Writable, reply: Reply): Promise<boolean> {
  try {
    await write(stream, `${JSON.stringify(reply)}\n`);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function write(stream: Writable, text: string): Promise<void> {
  if (stream.destroyed) throw new Error('The caller has disconnected');
  if (stream.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      stream.off('drain', onDrain).off('close', onClose).off('error', settle);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => {
      settle();
    };
    const onClose = (): void => {
      settle(new Error('The caller has disconnected'));
    };
    stream.once('drain', onDrain).once('close', onClose).once('error', settle);
  });
}

async function finish(stream: Writable): Promise<void> {
  if (stream.destroyed) return;
  await new Promise<void>((resolve) => stream.end(resolve));
}
