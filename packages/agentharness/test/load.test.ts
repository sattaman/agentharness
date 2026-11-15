import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
        knowledge: {
          dir: join(fixtures, 'valid', 'helper', 'knowledge'),
          files: [join('guides', 'setup.md'), 'office.md'],
        },
      },
    ]);
  });

  it('explains an empty agents folder', () => {
    expect(() => loadAgents(join(fixtures, 'empty'))).toThrow(/has no agents/);
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
    ['badjson', /agent\.json is not valid JSON/],
  ])('rejects %s', (folder, message) => {
    expect(() => loadAgent(join(fixtures, 'invalid', folder))).toThrow(message);
  });
});

describe('knowledge', () => {
  it('treats a knowledge folder with only hidden files as no knowledge', () => {
    expect(loadAgent(join(fixtures, 'knowledge', 'emptyknowledge')).knowledge).toBeUndefined();
  });

  it('caps the size of a knowledge folder', () => {
    const agent = join(mkdtempSync(join(tmpdir(), 'agentharness-')), 'big');
    mkdirSync(join(agent, 'knowledge'), { recursive: true });
    writeFileSync(join(agent, 'agent.json'), '{ "model": "nova-2-lite" }');
    writeFileSync(join(agent, 'prompt.md'), 'Answer from the documents.');
    writeFileSync(join(agent, 'knowledge', 'big.md'), Buffer.alloc(10 * 1024 * 1024 + 1));

    expect(() => loadAgent(agent)).toThrow(/the limit is 10485760/);
  });
});
