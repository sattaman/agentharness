import { models, type AgentConfig } from './schema.js';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export type Limits = Pick<AgentConfig, 'model' | 'maxTokens' | 'maxIterations'>;

export const noUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

export const toMicros = (usd: number): number => Math.round(usd * 1_000_000);

export function costMicros(model: Limits['model'], usage: Usage): number {
  const price = models[model].usdPerMillionTokens;
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite,
  );
}

const inputAllowancePerModelCall = 64_000;

export function reservationMicros({ model, maxTokens, maxIterations }: Limits): number {
  const price = models[model].usdPerMillionTokens;
  return Math.ceil(
    maxIterations * inputAllowancePerModelCall * price.input + 2 * maxTokens * price.output,
  );
}

export const ledgerKey = (caller: string, at: Date): string =>
  `${caller}#${at.toISOString().slice(0, 7)}`;
