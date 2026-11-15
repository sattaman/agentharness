import { describe, expect, it } from 'vitest';
import { addUsage, costMicros, ledgerKey, noUsage, reservationMicros } from '../src/spend.js';

const helperLimits = { model: 'nova-2-lite', maxTokens: 1024, maxIterations: 5 } as const;

describe('costMicros', () => {
  it('prices input, output and cache tokens separately', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(costMicros('nova-2-lite', usage)).toBe(420_000 + 3_520_000 + 105_000);
  });

  it('rounds up, so small calls are never free', () => {
    expect(costMicros('nova-2-lite', { ...noUsage, outputTokens: 1 })).toBe(4);
  });
});

describe('reservationMicros', () => {
  it('covers every model call and a final call past the token budget', () => {
    const reserved = reservationMicros(helperLimits);
    expect(reserved).toBe(Math.ceil(5 * 64_000 * 0.42 + 2 * 1024 * 3.52));
    const busiest = { ...noUsage, inputTokens: 5 * 64_000, outputTokens: 2 * 1024 };
    expect(reserved).toBeGreaterThanOrEqual(costMicros('nova-2-lite', busiest));
  });
});

describe('addUsage', () => {
  it('sums usage across model calls', () => {
    const call = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    expect(addUsage(call, call)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
    });
  });
});

describe('ledgerKey', () => {
  it('starts a new allowance each UTC month', () => {
    expect(ledgerKey('support', new Date('2026-11-30T23:59:59Z'))).toBe('support#2026-11');
    expect(ledgerKey('support', new Date('2026-12-01T00:00:00Z'))).toBe('support#2026-12');
  });
});
