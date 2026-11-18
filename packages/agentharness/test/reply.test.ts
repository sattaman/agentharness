import type {
  HarnessToolResultBlockDelta,
  HarnessToolUseStatus,
  InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { repliesFrom, replySchema, type Reply, type ReplyOptions } from '../src/reply.js';

type Event = InvokeHarnessStreamOutput;

// A real InvokeHarness stream (helper agent, one knowledge search), recorded with
// `pnpm --dir tools/smoke record`. Bucket and data source names are replaced.
// The recording is trusted test data, so its events are typed without validation.
const recorded = z.array(z.custom<Event>()).parse(
  readFileSync(new URL('fixtures/streams/retrieve.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line)),
);

async function replies(events: readonly Event[], options?: ReplyOptions): Promise<Reply[]> {
  const out: Reply[] = [];
  for await (const reply of repliesFrom(ReadableStream.from(events), options)) out.push(reply);
  return out;
}

const toolUseId = 'tooluse_C537IO8gfVx6vIovMZQpWZ';
const tool = 'knowledge___Retrieve';

describe('repliesFrom on a recorded tool call', () => {
  it('reports the call, its input and its result, matched by the tool-use ID', async () => {
    const out = await replies(recorded);
    expect(out.filter((reply) => reply.type.startsWith('tool'))).toEqual([
      { type: 'tool', id: toolUseId, name: tool },
      {
        type: 'toolInput',
        id: toolUseId,
        delta: '{"retrievalQuery":{"text":"What is the office plant called?"}}',
      },
      { type: 'toolResult', id: toolUseId, status: 'success' },
    ]);
  });

  it('keeps reading after the intermediate tool_use and tool_result stops', async () => {
    const out = await replies(recorded);
    const text = out.flatMap((reply) => (reply.type === 'text' ? [reply.text] : [])).join('');
    expect(text).toBe(
      'The office plant is a large fern called Ferngus. It is watered every Thursday.',
    );
    expect(out.some((reply) => reply.type === 'stopped')).toBe(false);
    expect(out.filter((reply) => reply.type === 'usage')).toHaveLength(2);
  });

  it('withholds result content unless the tool is marked as shared', async () => {
    const out = await replies(recorded);
    expect(JSON.stringify(out)).not.toContain('example-knowledge-bucket');
  });

  it('includes parsed result content for a shared tool', async () => {
    const out = await replies(recorded, { sharesResult: (name) => name === tool });
    const result = out.find((reply) => reply.type === 'toolResult');
    expect(result).toMatchObject({ type: 'toolResult', status: 'success' });
    expect(JSON.stringify(result)).toContain('large fern called Ferngus');
  });

  it('produces only replies that match the published schema', async () => {
    const out = await replies(recorded, { sharesResult: () => true });
    for (const reply of out) expect(replySchema.parse(reply)).toEqual(reply);
  });
});

describe('repliesFrom on tool edge cases', () => {
  const use = (index: number, id: string, name: string): Event => ({
    contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: id, name } } },
  });
  const input = (index: number, text: string): Event => ({
    contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: text } } },
  });
  const resultStart = (index: number, id: string, status: HarnessToolUseStatus): Event => ({
    contentBlockStart: {
      contentBlockIndex: index,
      start: { toolResult: { toolUseId: id, status } },
    },
  });
  const resultPart = (index: number, part: HarnessToolResultBlockDelta): Event => ({
    contentBlockDelta: { contentBlockIndex: index, delta: { toolResult: [part] } },
  });
  const stop = (index: number): Event => ({ contentBlockStop: { contentBlockIndex: index } });
  const start = (role: 'assistant' | 'user'): Event => ({ messageStart: { role } });
  const shared = { sharesResult: () => true };

  it('forwards input fragments in order and ties parallel calls to their own IDs', async () => {
    const out = await replies([
      start('assistant'),
      use(0, 'a', 'costs___get_costs'),
      input(0, '{"from":'),
      use(1, 'b', 'costs___get_costs'),
      input(1, '{}'),
      input(0, '"2026-11-01"}'),
      stop(0),
      stop(1),
    ]);
    expect(out).toEqual([
      { type: 'tool', id: 'a', name: 'costs___get_costs' },
      { type: 'toolInput', id: 'a', delta: '{"from":' },
      { type: 'tool', id: 'b', name: 'costs___get_costs' },
      { type: 'toolInput', id: 'b', delta: '{}' },
      { type: 'toolInput', id: 'a', delta: '"2026-11-01"}' },
    ]);
  });

  it('assembles a result streamed in several text parts', async () => {
    const out = await replies(
      [
        start('assistant'),
        use(0, 'a', 'costs___get_costs'),
        start('user'),
        resultStart(0, 'a', 'success'),
        resultPart(0, { text: '{"total":' }),
        resultPart(0, { text: '12.5}' }),
        stop(0),
      ],
      shared,
    );
    expect(out.at(-1)).toEqual({
      type: 'toolResult',
      id: 'a',
      status: 'success',
      content: { total: 12.5 },
    });
  });

  it('passes JSON parts through, keeps non-JSON text as text, and reports errors', async () => {
    const out = await replies(
      [
        use(0, 'a', 'x'),
        use(1, 'b', 'y'),
        resultStart(0, 'a', 'success'),
        resultPart(0, { json: { rows: [1, 2] } }),
        stop(0),
        resultStart(1, 'b', 'error'),
        resultPart(1, { text: 'Access denied' }),
        stop(1),
      ],
      shared,
    );
    expect(out.filter((reply) => reply.type === 'toolResult')).toEqual([
      { type: 'toolResult', id: 'a', status: 'success', content: { rows: [1, 2] } },
      { type: 'toolResult', id: 'b', status: 'error', content: 'Access denied' },
    ]);
  });
});
