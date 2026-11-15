import type { InvokeHarnessCommandOutput } from '@aws-sdk/client-bedrock-agentcore';
import { z } from 'zod';

export const replySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('tool'), name: z.string() }),
  z.strictObject({ type: z.literal('stopped'), reason: z.string() }),
  z.strictObject({
    type: z.literal('usage'),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);

export type Reply = z.infer<typeof replySchema>;

type HarnessStream = NonNullable<InvokeHarnessCommandOutput['stream']>;

const normalStops = new Set<string>(['end_turn', 'tool_use', 'tool_result']);

export async function* repliesFrom(stream: HarnessStream): AsyncGenerator<Reply> {
  for await (const event of stream) {
    const error =
      event.runtimeClientError ?? event.validationException ?? event.internalServerException;
    if (error) throw new Error(error.message);

    const tool = event.contentBlockStart?.start?.toolUse?.name;
    if (tool !== undefined) yield { type: 'tool', name: tool };

    const text = event.contentBlockDelta?.delta?.text;
    if (text !== undefined) yield { type: 'text', text };

    const reason = event.messageStop?.stopReason;
    if (reason !== undefined && !normalStops.has(reason)) yield { type: 'stopped', reason };

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
