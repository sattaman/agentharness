import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { init } from '../src/init.js';
import { loadAgents } from '../src/load.js';

const workspace = (): string => mkdtempSync(join(tmpdir(), 'init-'));
const starterSchema = z.looseObject({
  name: z.string(),
  devDependencies: z.record(z.string(), z.string()),
});

describe('init', () => {
  it('creates a starter repo with a valid agent, ready to deploy', () => {
    const dir = join(workspace(), 'My Agents');
    init(dir);

    for (const file of ['README.md', 'cdk.json', 'callers.json', '.gitignore']) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(existsSync(join(dir, 'gitignore'))).toBe(false);
    expect(loadAgents(join(dir, 'agents')).map(({ name }) => name)).toEqual(['helper']);

    const starter = starterSchema.parse(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    );
    expect(starter.name).toBe('my-agents');
    expect(starter.devDependencies['agentharness']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(Object.keys(starter.devDependencies).sort()).toEqual([
      'agentharness',
      'aws-cdk',
      'aws-cdk-lib',
      'constructs',
    ]);
  });

  it('refuses to overwrite a folder that has files in it', () => {
    const dir = join(workspace(), 'taken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.md'), 'mine');
    expect(() => {
      init(dir);
    }).toThrow("already exists and isn't empty");
  });
});
