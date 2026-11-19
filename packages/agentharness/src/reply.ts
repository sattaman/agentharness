import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore';
import { z } from 'zod';

export const replySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  /** The agent started a tool call. `id` ties its input, end and result to it. */
  z.strictObject({ type: z.literal('tool'), id: z.string().min(1), name: z.string() }),
  /** A fragment of the tool call's JSON input; the fragments for one `id` concatenate to it. */
  z.strictObject({ type: z.literal('toolInput'), id: z.string().min(1), delta: z.string() }),
  /** The tool call's input is complete; the tool is now running. */
  z.strictObject({ type: z.literal('toolEnd'), id: z.string().min(1) }),
  /**
   * The tool finished. `content` is present only for successful results of tools the agent
   * shares with callers: other results, and error messages, can hold internals such as
   * bucket names and ARNs. `tooLarge` means a shared result was withheld for its size.
   */
  z.strictObject({
    type: z.literal('toolResult'),
    id: z.string().min(1),
    status: z.enum(['success', 'error']),
    content: z.unknown().optional(),
    tooLarge: z.literal(true).optional(),
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
      /** Whether the content is collected at all: only for shared, successful results. */
      readonly shared: boolean;
      text: string;
      readonly json: unknown[];
      size: number;
    };

/** The largest shared result sent to callers, so one tool can't produce an unbounded line. */
export const maxResultBytes = 256 * 1024;

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
      // A tool block without an ID can't be tied to anything, so it is skipped.
      if (toolUse?.name !== undefined && nonEmpty(toolUse.toolUseId)) {
        const id = toolUse.toolUseId;
        toolNames.set(id, toolUse.name);
        blocks.set(index, { kind: 'use', id });
        yield { type: 'tool', id, name: toolUse.name };
      }
      if (toolResult !== undefined && nonEmpty(toolResult.toolUseId)) {
        // Anything but an explicit success counts as an error.
        const status = toolResult.status === 'success' ? 'success' : 'error';
        const name = toolNames.get(toolResult.toolUseId);
        blocks.set(index, {
          kind: 'result',
          id: toolResult.toolUseId,
          status,
          shared: status === 'success' && name !== undefined && sharesResult(name),
          text: '',
          json: [],
          size: 0,
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
      if (delta?.toolResult !== undefined && block?.kind === 'result' && block.shared) {
        for (const part of delta.toolResult) {
          if (block.size > maxResultBytes) break;
          if (part.text !== undefined) {
            block.text += part.text;
            block.size += Buffer.byteLength(part.text);
          }
          if (part.json !== undefined) {
            block.json.push(part.json);
            block.size += Buffer.byteLength(JSON.stringify(part.json));
          }
        }
      }
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex ?? 0;
      const block = blocks.get(index);
      blocks.delete(index);
      if (block?.kind === 'use') yield { type: 'toolEnd', id: block.id };
      if (block?.kind === 'result') {
        const { id, status, shared, size } = block;
        if (shared && size > maxResultBytes)
          yield { type: 'toolResult', id, status, tooLarge: true };
        else if (shared) yield { type: 'toolResult', id, status, content: contentOf(block) };
        else yield { type: 'toolResult', id, status };
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

const nonEmpty = (id: string | undefined): id is string => id !== undefined && id !== '';

/** JSON parts as they are; otherwise the text, parsed when it is JSON. */
function contentOf({ text, json }: { readonly text: string; readonly json: unknown[] }): unknown {
  if (json.length > 0) return json.length === 1 ? json[0] : json;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
