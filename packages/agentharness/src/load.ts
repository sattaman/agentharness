import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { maintainers } from './names.js';
import {
  agentConfigSchema,
  callersConfigSchema,
  type AgentConfig,
  type CallersConfig,
} from './schema.js';

export interface AgentSpec {
  readonly name: string;
  readonly prompt: string;
  readonly config: AgentConfig;
  readonly knowledge: KnowledgeFiles | undefined;
}

export interface KnowledgeFiles {
  readonly dir: string;
  readonly files: readonly string[];
}

const maxKnowledgeBytes = 10 * 1024 * 1024;
const maxPromptCharacters = 20_000;

const agentName = /^[a-z][a-z0-9]{0,15}$/;

export function loadAgents(dir: string): AgentSpec[] {
  if (!existsSync(dir))
    throw new Error(`No ${dir}/ folder found. Create ${dir}/<name>/agent.json.`);

  const agents = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadAgent(join(dir, entry.name)));

  if (agents.length === 0)
    throw new Error(`${dir}/ has no agents. Create ${dir}/<name>/agent.json.`);
  return agents;
}

export function loadAgent(dir: string): AgentSpec {
  const name = basename(dir);
  if (!agentName.test(name)) {
    throw new Error(
      `${dir}: agent names must be 1-16 lowercase letters or digits, starting with a letter`,
    );
  }

  const config = agentConfigSchema.safeParse(readJson(join(dir, 'agent.json')));
  if (!config.success) throw new Error(`${dir}/agent.json\n${z.prettifyError(config.error)}`);

  const prompt = read(join(dir, 'prompt.md')).trim();
  if (prompt === '') throw new Error(`${dir}/prompt.md is empty`);
  if (prompt.length > maxPromptCharacters) {
    throw new Error(
      `${dir}/prompt.md is ${String(prompt.length)} characters; the limit is ${String(maxPromptCharacters)}`,
    );
  }

  return { name, prompt, config: config.data, knowledge: loadKnowledge(join(dir, 'knowledge')) };
}

export function loadCallers(path: string, agents: readonly AgentSpec[]): CallersConfig {
  if (!existsSync(path)) return {};
  const callers = callersConfigSchema.safeParse(readJson(path));
  if (!callers.success) throw new Error(`${path}\n${z.prettifyError(callers.error)}`);

  const known = new Set([maintainers, ...agents.flatMap(({ config }) => config.callers)]);
  const unknown = Object.keys(callers.data).filter((caller) => !known.has(caller));
  if (unknown.length > 0) {
    throw new Error(`${path} sets budgets for ${unknown.join(', ')}, but no agent lists them`);
  }
  return callers.data;
}

function loadKnowledge(dir: string): KnowledgeFiles | undefined {
  if (!existsSync(dir)) return undefined;

  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split(sep).some((part) => part.startsWith('.')))
    .sort();
  if (files.length === 0) return undefined;

  const bytes = files.reduce((total, file) => total + statSync(join(dir, file)).size, 0);
  if (bytes > maxKnowledgeBytes) {
    throw new Error(`${dir} is ${String(bytes)} bytes; the limit is ${String(maxKnowledgeBytes)}`);
  }
  return { dir, files };
}

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
}
