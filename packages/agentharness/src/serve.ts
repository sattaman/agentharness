import type { InvokeHarnessCommandInput } from '@aws-sdk/client-bedrock-agentcore';
import type { Reply } from './reply.js';
import { chatRequestSchema, invocation, mayCall, type Caller, type Grants } from './request.js';
import {
  addUsage,
  costMicros,
  ledgerKey,
  noUsage,
  reservationMicros,
  type Limits,
  type Usage,
} from './spend.js';

export interface Call {
  readonly requestId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly body: string | null;
}

export interface Writer {
  /** Resolves false once the caller has gone; accounting carries on regardless. */
  write(text: string): Promise<boolean>;
  end(): Promise<void>;
}

export interface FrontDoor {
  readonly grants: Grants;
  readonly limits: Readonly<Record<string, Limits>>;
  findHarness(agent: string): Promise<string | undefined>;
  invoke(input: InvokeHarnessCommandInput): AsyncIterable<Reply>;
  reserve(key: string, micros: number, budgetMicros: number, ledgerId: string): Promise<boolean>;
  settle(key: string, deltaMicros: number, ledgerId: string): Promise<void>;
  open(statusCode: number, contentType: string): Writer;
  now(): Date;
  newId(): string;
  error(error: unknown): void;
}

export type Summary = Readonly<Record<string, unknown>>;

export async function serve(call: Call, door: FrontDoor): Promise<Summary> {
  const grant = door.grants.get(call.clientId);
  const caller: Caller = { clientId: call.clientId, scopes: call.scope.split(' ') };
  const ledgerId = door.newId();
  const base = {
    requestId: call.requestId,
    ledgerId,
    clientId: call.clientId,
    caller: grant?.caller,
  };

  const reject = async (statusCode: number, message: string, agent?: string): Promise<Summary> => {
    const out = door.open(statusCode, 'application/json');
    await out.write(JSON.stringify({ message }));
    await out.end();
    return { ...base, agent, outcome: `rejected ${String(statusCode)}` };
  };

  if (grant === undefined) return reject(403, 'Unknown caller');
  const request = chatRequestSchema.safeParse(parseJson(call.body));
  if (!request.success) return reject(400, 'Send {"agent", "message", "sessionId"}');
  const { agent } = request.data;
  if (!mayCall(caller, agent, door.grants))
    return reject(403, 'Not allowed to call this agent', agent);
  const limits = door.limits[agent];
  const harnessArn = await door.findHarness(agent);
  if (limits === undefined || harnessArn === undefined) {
    return reject(404, 'No such agent is deployed', agent);
  }

  const reserved = reservationMicros(limits);
  const key = ledgerKey(grant.caller, door.now());
  let admitted: boolean;
  try {
    admitted =
      reserved <= grant.budgetMicros &&
      (await door.reserve(key, reserved, grant.budgetMicros, ledgerId));
  } catch (error) {
    door.error(error);
    return reject(503, 'The budget check is unavailable. Try again later.', agent);
  }
  if (!admitted) return reject(429, 'This caller has used its monthly budget', agent);

  const out = door.open(200, 'application/x-ndjson');
  const send = (reply: Reply): Promise<boolean> => out.write(`${JSON.stringify(reply)}\n`);
  let usage: Usage = noUsage;
  let metered = false;
  let complete = false;
  let delivering = true;
  let outcome = 'ok';
  try {
    for await (const reply of door.invoke(invocation(harnessArn, caller, request.data))) {
      if (reply.type === 'usage') {
        usage = addUsage(usage, reply);
        metered = true;
      }
      if (delivering) delivering = await send(reply);
    }
    complete = true;
  } catch (error) {
    outcome = 'failed';
    door.error(error);
    if (delivering) await send({ type: 'error', message: 'The agent failed. Try again.' });
  }

  const settled = complete && metered;
  const charged = settled ? costMicros(limits.model, usage) : reserved;
  let accounting = settled ? 'settled' : 'reservation kept';
  try {
    await door.settle(key, charged - reserved, ledgerId);
  } catch (error) {
    door.error(error);
    accounting = 'settle failed; reservation kept';
  }
  await out.end();

  return {
    ...base,
    agent,
    outcome,
    model: limits.model,
    ...usage,
    costUsd: charged / 1_000_000,
    reservedUsd: reserved / 1_000_000,
    overReservation: charged > reserved,
    accounting,
  };
}

function parseJson(body: string | null): unknown {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
}
