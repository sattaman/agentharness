import type { InvokeHarnessCommandInput } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it } from 'vitest';
import { replySchema, type Reply } from '../src/reply.js';
import { serve, type Call, type FrontDoor } from '../src/serve.js';
import { costMicros, reservationMicros } from '../src/spend.js';

const limits = { model: 'nova-2-lite', maxTokens: 1024, maxIterations: 5 } as const;
const reserved = reservationMicros(limits);
const usage = { inputTokens: 2000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const cost = costMicros('nova-2-lite', usage);
const sessionId = '0b8f3c1e-7a51-4c1d-9b6e-2f4a9d8e6c10';

const call = (body: unknown, overrides: Partial<Call> = {}): Call => ({
  requestId: 'request-1',
  clientId: 'support-id',
  scope: 'agentharness/helper',
  body: JSON.stringify(body),
  ...overrides,
});
const ask = { agent: 'helper', message: 'Hello', sessionId };

interface Fake {
  readonly door: FrontDoor;
  readonly status: number[];
  readonly written: string[];
  readonly invoked: InvokeHarnessCommandInput[];
  readonly reserves: unknown[][];
  readonly settles: unknown[][];
}

function fake(
  options: {
    replies?: () => AsyncIterable<Reply>;
    reserve?: () => Promise<boolean>;
    settle?: () => Promise<void>;
    callerGoneAfter?: number;
    budgetMicros?: number;
  } = {},
): Fake {
  const result: Fake = {
    status: [],
    written: [],
    invoked: [],
    reserves: [],
    settles: [],
    door: {
      grants: new Map([
        [
          'support-id',
          {
            caller: 'support',
            agents: ['helper'],
            budgetMicros: options.budgetMicros ?? 5_000_000,
          },
        ],
      ]),
      limits: { helper: limits },
      findHarness: (agent) => Promise.resolve(agent === 'helper' ? 'harness-arn' : undefined),
      invoke: (input) => {
        result.invoked.push(input);
        return (options.replies ?? answer)();
      },
      reserve: (...args) => {
        result.reserves.push(args);
        return options.reserve ? options.reserve() : Promise.resolve(true);
      },
      settle: (...args) => {
        result.settles.push(args);
        return options.settle ? options.settle() : Promise.resolve();
      },
      open: (statusCode) => {
        result.status.push(statusCode);
        return {
          write: (text) => {
            result.written.push(text);
            const gone =
              options.callerGoneAfter !== undefined &&
              result.written.length >= options.callerGoneAfter;
            return Promise.resolve(!gone);
          },
          end: () => Promise.resolve(),
        };
      },
      now: () => new Date('2026-11-15T12:00:00Z'),
      newId: () => 'ledger-1',
      error: () => undefined,
    },
  };
  return result;
}

async function* answer(): AsyncGenerator<Reply> {
  await Promise.resolve();
  yield { type: 'text', text: 'Hi' };
  yield { type: 'usage', ...usage };
}

describe('serve: rejections', () => {
  it.each([
    ['an unknown client', call(ask, { clientId: 'stranger' }), 403],
    ['a malformed body', call({ ...ask, allowedTools: ['*'] }), 400],
    ['an agent the caller is not granted', call({ ...ask, agent: 'plain' }), 403],
    ['a token without the agent scope', call(ask, { scope: 'agentharness/plain' }), 403],
    [
      'an agent that is not deployed',
      call({ ...ask, agent: 'ghost' }, { scope: 'agentharness/ghost' }),
      403,
    ],
  ])('rejects %s before spending anything', async (_, request, status) => {
    const { door, status: statuses, reserves, invoked } = fake();
    await serve(request, door);
    expect(statuses).toEqual([status]);
    expect(reserves).toEqual([]);
    expect(invoked).toEqual([]);
  });

  it('returns 404 for a granted agent with no deployed Harness', async () => {
    const f = fake();
    const door = { ...f.door, findHarness: () => Promise.resolve(undefined) };
    await serve(call(ask), door);
    expect(f.status).toEqual([404]);
    expect(f.reserves).toEqual([]);
  });

  it('returns 429 without invoking when the reservation does not fit', async () => {
    const f = fake({ reserve: () => Promise.resolve(false) });
    expect(await serve(call(ask), f.door)).toMatchObject({ outcome: 'rejected 429' });
    expect(f.status).toEqual([429]);
    expect(f.invoked).toEqual([]);
  });

  it('returns 429 without touching the ledger when the budget is below one reservation', async () => {
    const f = fake({ budgetMicros: reserved - 1 });
    await serve(call(ask), f.door);
    expect(f.status).toEqual([429]);
    expect(f.reserves).toEqual([]);
  });

  it('fails closed with 503 when the ledger is unavailable', async () => {
    const f = fake({ reserve: () => Promise.reject(new Error('DynamoDB down')) });
    await serve(call(ask), f.door);
    expect(f.status).toEqual([503]);
    expect(f.invoked).toEqual([]);
  });
});

describe('serve: a call', () => {
  it('reserves, streams, then settles the actual cost', async () => {
    const f = fake();
    const summary = await serve(call(ask), f.door);
    expect(f.status).toEqual([200]);
    expect(f.written.map((line) => replySchema.parse(JSON.parse(line)))).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'usage', ...usage },
    ]);
    expect(f.reserves).toEqual([['support#2026-11', reserved, 5_000_000, 'ledger-1']]);
    expect(f.settles).toEqual([['support#2026-11', cost - reserved, 'ledger-1']]);
    expect(summary).toMatchObject({ outcome: 'ok', accounting: 'settled', caller: 'support' });
  });

  it('sends the Harness only the message, never caller settings', async () => {
    const f = fake();
    await serve(call(ask), f.door);
    const [input] = f.invoked;
    expect(Object.keys(input ?? {}).sort()).toEqual(['harnessArn', 'messages', 'runtimeSessionId']);
    expect(input?.messages).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(input?.runtimeSessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the reservation when the agent fails part-way', async () => {
    const f = fake({
      replies: async function* () {
        yield { type: 'usage', ...usage };
        await Promise.resolve();
        throw new Error('stream broke');
      },
    });
    const summary = await serve(call(ask), f.door);
    expect(f.settles).toEqual([['support#2026-11', 0, 'ledger-1']]);
    expect(f.written.at(-1)).toContain('"type":"error"');
    expect(summary).toMatchObject({ outcome: 'failed', accounting: 'reservation kept' });
  });

  it('charges reported usage over the reservation when the agent fails part-way', async () => {
    const big = { ...usage, inputTokens: 5_000_000 };
    const f = fake({
      replies: async function* () {
        yield { type: 'usage', ...big };
        await Promise.resolve();
        throw new Error('stream broke');
      },
    });
    const over = costMicros('nova-2-lite', big);
    expect(over).toBeGreaterThan(reserved);
    const summary = await serve(call(ask), f.door);
    expect(f.settles).toEqual([['support#2026-11', over - reserved, 'ledger-1']]);
    expect(summary).toMatchObject({
      outcome: 'failed',
      accounting: 'reported usage',
      overReservation: true,
    });
  });

  it('keeps the reservation when no usage was reported', async () => {
    const f = fake({
      replies: async function* () {
        await Promise.resolve();
        yield { type: 'text', text: 'Hi' };
      },
    });
    expect(await serve(call(ask), f.door)).toMatchObject({ accounting: 'reservation kept' });
    expect(f.settles).toEqual([['support#2026-11', 0, 'ledger-1']]);
  });

  it('keeps accounting after the caller disconnects', async () => {
    const f = fake({ callerGoneAfter: 1 });
    expect(await serve(call(ask), f.door)).toMatchObject({ accounting: 'settled' });
    expect(f.written).toHaveLength(1);
    expect(f.settles).toEqual([['support#2026-11', cost - reserved, 'ledger-1']]);
  });

  it('reports a failed settlement, leaving the reservation charged', async () => {
    const f = fake({ settle: () => Promise.reject(new Error('DynamoDB down')) });
    expect(await serve(call(ask), f.door)).toMatchObject({
      accounting: 'settle failed; reservation kept',
    });
  });

  it('never logs the message', async () => {
    const summary = await serve(call({ ...ask, message: 'my secret plans' }), fake().door);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });
});
