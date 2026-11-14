import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { agentConfigSchema, type AgentConfig } from './schema.js';

export interface AgentSpec {
  readonly name: string;
  readonly prompt: string;
  readonly config: AgentConfig;
}

const agentName = /^[a-z][a-z0-9]{0,15}$/;

export function loadAgents(dir: string): AgentSpec[] {
  if (!existsSync(dir))
    throw new Error(`No ${dir}/ folder found. Create ${dir}/<name>/agent.json.`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadAgent(join(dir, entry.name)));
}

export function loadAgent(dir: string): AgentSpec {
  const name = basename(dir);
  if (!agentName.test(name)) {
    throw new Error(
      `${dir}: agent names must be 1-16 lowercase letters or digits, starting with a letter`,
    );
  }
  const config = agentConfigSchema.safeParse(JSON.parse(readRequired(dir, 'agent.json')));
  if (!config.success) throw new Error(`${dir}/agent.json\n${z.prettifyError(config.error)}`);

  const prompt = readRequired(dir, 'prompt.md').trim();
  if (prompt === '') throw new Error(`${dir}/prompt.md is empty`);

  return { name, prompt, config: config.data };
}

function readRequired(dir: string, file: string): string {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8');
}
