import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore';
import { z } from 'zod';

export const replySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  /** The agent started a tool call. `id` ties its input and result to it. */
  z.strictObject({ type: z.literal('tool'), id: z.string(), name: z.string() }),
  /** A fragment of the tool call's JSON input; the fragments for one `id` concatenate to it. */
  z.strictObject({ type: z.literal('toolInput'), id: z.string(), delta: z.string() }),
  /**
   * The tool finished. `content` is present only for tools whose results the agent shares
   * with callers; other results can hold internals such as bucket names.
   */
  z.strictObject({
    type: z.literal('toolResult'),
    id: z.string(),
    status: z.enum(['success', 'error']),
    content: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal('stopped'), reason: z.string() }),
  z.strictObject({
    type: z.literal('usage'),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);

export type Reply = z.infer<typeof replySchema>;

export interface ReplyOptions {
  /** Whether callers may see the results of this tool, by its stream name. Default: none. */
  readonly sharesResult?: (tool: string) => boolean;
}

/** A tool block open in the current message, by content-block index. */
type Block =
  | { readonly kind: 'use'; readonly id: string }
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly status: 'success' | 'error';
      text: string;
      readonly json: unknown[];
    };

// tool_use and tool_result end intermediate messages while the Harness runs tools; the run goes on.
const normalStops = new Set<string>(['end_turn', 'tool_use', 'tool_result']);

export async function* repliesFrom(
  stream: AsyncIterable<InvokeHarnessStreamOutput>,
  { sharesResult = () => false }: ReplyOptions = {},
): AsyncGenerator<Reply> {
  const toolNames = new Map<string, string>();
  const blocks = new Map<number, Block>();

  for await (const event of stream) {
    const error =
      event.runtimeClientError ?? event.validationException ?? event.internalServerException;
    if (error) throw new Error(error.message);

    // Block indexes restart with each message.
    if (event.messageStart) blocks.clear();

    if (event.contentBlockStart) {
      const index = event.contentBlockStart.contentBlockIndex ?? 0;
      const { toolUse, toolResult } = event.contentBlockStart.start ?? {};
      if (toolUse?.name !== undefined) {
        const id = toolUse.toolUseId ?? '';
        toolNames.set(id, toolUse.name);
        blocks.set(index, { kind: 'use', id });
        yield { type: 'tool', id, name: toolUse.name };
      }
      if (toolResult !== undefined) {
        const status = toolResult.status === 'error' ? 'error' : 'success';
        blocks.set(index, {
          kind: 'result',
          id: toolResult.toolUseId ?? '',
          status,
          text: '',
          json: [],
        });
      }
    }

    if (event.contentBlockDelta) {
      const block = blocks.get(event.contentBlockDelta.contentBlockIndex ?? 0);
      const delta = event.contentBlockDelta.delta;
      if (delta?.text !== undefined) yield { type: 'text', text: delta.text };
      if (delta?.toolUse?.input !== undefined && block?.kind === 'use') {
        yield { type: 'toolInput', id: block.id, delta: delta.toolUse.input };
      }
      if (delta?.toolResult !== undefined && block?.kind === 'result') {
        for (const part of delta.toolResult) {
          if (part.text !== undefined) block.text += part.text;
          if (part.json !== undefined) block.json.push(part.json);
        }
      }
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex ?? 0;
      const block = blocks.get(index);
      blocks.delete(index);
      if (block?.kind === 'result') {
        const shared = sharesResult(toolNames.get(block.id) ?? '');
        yield {
          type: 'toolResult',
          id: block.id,
          status: block.status,
          ...(shared ? { content: contentOf(block) } : {}),
        };
      }
    }

    const reason = event.messageStop?.stopReason;
    if (reason !== undefined && !normalStops.has(reason)) yield { type: 'stopped', reason };

    const usage = event.metadata?.usage;
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadInputTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
      };
    }
  }
}

/** JSON parts as they are; otherwise the text, parsed when it is JSON. */
function contentOf({ text, json }: { readonly text: string; readonly json: unknown[] }): unknown {
  if (json.length > 0) return json.length === 1 ? json[0] : json;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
