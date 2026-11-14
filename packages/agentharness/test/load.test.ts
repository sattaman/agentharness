import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgent, loadAgents } from '../src/load.js';

const fixtures = join(import.meta.dirname, 'fixtures');

describe('loadAgents', () => {
  it('loads every agent folder with defaults applied', () => {
    expect(loadAgents(join(fixtures, 'valid'))).toEqual([
      {
        name: 'helper',
        prompt: 'You are a test agent.',
        config: { model: 'nova-2-lite', maxTokens: 1024, maxIterations: 5, timeoutSeconds: 120 },
      },
    ]);
  });

  it('explains a missing agents folder', () => {
    expect(() => loadAgents(join(fixtures, 'nowhere'))).toThrow(/No .*nowhere\/ folder found/);
  });
});

describe('loadAgent', () => {
  it.each([
    ['badmodel', /agent\.json[\s\S]*model/],
    ['noprompt', /prompt\.md is missing/],
    ['Bad-Name', /agent names must be/],
  ])('rejects %s', (folder, message) => {
    expect(() => loadAgent(join(fixtures, 'invalid', folder))).toThrow(message);
  });
});
