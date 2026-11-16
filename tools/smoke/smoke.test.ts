import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  GetRoleCommand,
  IAMClient,
  SimulatePrincipalPolicyCommand,
  type ContextEntry,
} from '@aws-sdk/client-iam';
import {
  addUsage,
  costMicros,
  defaultMonthlyBudgetUsd,
  frontDoorRoleName,
  ledgerKey,
  loadAgents,
  loadCallers,
  maintainers,
  models,
  noUsage,
  reservationMicros,
  toMicros,
  type Reply,
} from 'agentharness';
import { ask } from 'agentharness-chat/client';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { findStage, type Stage } from './stage.ts';

const example = join(import.meta.dirname, '../../examples/helper');
const agents = loadAgents(join(example, 'agents'));
const callers = loadCallers(join(example, 'callers.json'), agents);
const [spec] = agents.filter(({ name }) => name === 'helper');
if (spec === undefined) throw new Error('The example has no helper agent');
const agent = spec.name;
const [guest] = spec.config.callers;
if (guest === undefined) throw new Error('The helper agent lists no callers');
const golden = { question: 'What is the office plant called?', fact: 'Ferngus' };

const dynamodb = new DynamoDBClient();
const iam = new IAMClient();
const agentcore = new BedrockAgentCoreClient();

let stage: Stage;
beforeAll(async () => {
  stage = await findStage(process.env['STAGE'] ?? 'dev');
});

const request = (overrides: object = {}): object => ({
  agent,
  message: 'Hello',
  sessionId: randomUUID(),
  ...overrides,
});

const post = (body: object, token?: string): Promise<Response> =>
  fetch(new URL('chat', stage.apiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: token }),
    },
    body: JSON.stringify(body),
  });

async function chat(token: string, message: string): Promise<Reply[]> {
  const replies: Reply[] = [];
  for await (const reply of ask(stage.apiUrl, token, { agent, message, sessionId: randomUUID() })) {
    replies.push(reply);
  }
  return replies;
}

const costOf = (replies: readonly Reply[]): number =>
  costMicros(
    spec.config.model,
    replies.reduce(
      (usage, reply) => (reply.type === 'usage' ? addUsage(usage, reply) : usage),
      noUsage,
    ),
  );

const key = (caller: string): { pk: { S: string } } => ({
  pk: { S: ledgerKey(caller, new Date()) },
});

async function charged(caller: string): Promise<number> {
  const { Item } = await dynamodb.send(
    new GetItemCommand({ TableName: stage.ledgerTable, Key: key(caller), ConsistentRead: true }),
  );
  return Number(Item?.['charged']?.N ?? '0');
}

async function adjust(caller: string, deltaMicros: number): Promise<void> {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: stage.ledgerTable,
      Key: key(caller),
      UpdateExpression: 'ADD charged :delta',
      ExpressionAttributeValues: { ':delta': { N: String(deltaMicros) } },
    }),
  );
}

async function roleArn(name: string): Promise<string> {
  const { Role } = await iam.send(new GetRoleCommand({ RoleName: name }));
  if (Role?.Arn === undefined) throw new Error(`No role ${name}`);
  return Role.Arn;
}

async function decisions(
  principal: string,
  actions: string[],
  resource: string,
  context: ContextEntry[] = [],
): Promise<Record<string, string | undefined>> {
  const { EvaluationResults } = await iam.send(
    new SimulatePrincipalPolicyCommand({
      PolicySourceArn: principal,
      ActionNames: actions,
      ResourceArns: [resource],
      ContextEntries: context,
    }),
  );
  const decided: Record<string, string | undefined> = {};
  for (const { EvalActionName, EvalDecision } of EvaluationResults ?? []) {
    if (EvalActionName !== undefined) decided[EvalActionName] = EvalDecision;
  }
  return decided;
}

describe('the front door', () => {
  it('answers from the agent’s knowledge', async () => {
    const replies = await chat(await stage.token(maintainers), golden.question);
    const text = replies.map((reply) => (reply.type === 'text' ? reply.text : '')).join('');
    expect(text).toContain(golden.fact);
    expect(replies.some((reply) => reply.type === 'tool' && reply.name.includes('Retrieve'))).toBe(
      true,
    );
    expect(replies.some(({ type }) => type === 'usage')).toBe(true);
    expect(replies.some(({ type }) => type === 'error')).toBe(false);
  });

  it('refuses a request without a token', async () => {
    expect((await post(request())).status).toBe(401);
  });

  it('refuses settings in the body', async () => {
    const token = await stage.token(maintainers);
    expect((await post(request({ allowedTools: ['*'] }), token)).status).toBe(400);
  });

  it('refuses an agent the caller is not granted', async () => {
    const token = await stage.token(guest);
    expect((await post(request({ agent: 'plain' }), token)).status).toBe(403);
  });
});

describe('the Harness', () => {
  it('refuses a token sent to it directly', async () => {
    const harnessArn = stage.harnessArn(agent);
    const region = harnessArn.split(':')[3] ?? '';
    const url = `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke?harnessArn=${encodeURIComponent(harnessArn)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await stage.token(maintainers)}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': randomUUID() + randomUUID(),
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'Hello' }] }] }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a model the agent was not given, even to IAM callers', async () => {
    const attempt = async (): Promise<void> => {
      const { stream } = await agentcore.send(
        new InvokeHarnessCommand({
          harnessArn: stage.harnessArn(agent),
          runtimeSessionId: randomUUID(),
          messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
          model: { bedrockModelConfig: { modelId: 'global.anthropic.claude-haiku-5-5' } },
        }),
      );
      for await (const event of stream ?? []) {
        const error =
          event.runtimeClientError ?? event.validationException ?? event.internalServerException;
        if (error) throw new Error(error.message);
      }
    };
    await expect(attempt()).rejects.toThrow(/not authorized to perform: bedrock:InvokeModel/);
  });
});

describe('spend', () => {
  it('charges every call its real cost, also when calls run at once', async () => {
    const token = await stage.token(maintainers);
    const before = await charged(maintainers);
    const calls = await Promise.all([1, 2, 3].map(() => chat(token, 'Where is the studio?')));
    const after = await charged(maintainers);
    expect(after - before).toBe(calls.reduce((total, replies) => total + costOf(replies), 0));
  });

  it('refuses a call that would take the caller over its budget', async () => {
    const budget = toMicros(callers[guest]?.monthlyBudgetUsd ?? defaultMonthlyBudgetUsd);
    const current = await charged(guest);
    const nearlySpent = budget - reservationMicros(spec.config) + 1;
    await adjust(guest, nearlySpent - current);
    try {
      expect((await post(request(), await stage.token(guest))).status).toBe(429);
    } finally {
      await adjust(guest, current - nearlySpent);
    }
  });
});

describe('IAM', () => {
  it('lets the front door invoke agents but never open a shell or run commands', async () => {
    const harnessArn = stage.harnessArn(agent);
    const role = await roleArn(frontDoorRoleName(stage.name, harnessArn.split(':')[3] ?? ''));
    expect(
      await decisions(
        role,
        [
          'bedrock-agentcore:InvokeHarness',
          'bedrock-agentcore:InvokeAgentRuntimeCommand',
          'bedrock-agentcore:InvokeAgentRuntimeCommandShell',
        ],
        harnessArn,
      ),
    ).toEqual({
      'bedrock-agentcore:InvokeHarness': 'allowed',
      'bedrock-agentcore:InvokeAgentRuntimeCommand': 'implicitDeny',
      'bedrock-agentcore:InvokeAgentRuntimeCommandShell': 'implicitDeny',
    });
  });

  it('limits an agent to its own model, through its inference profile', async () => {
    const [, , , region, account] = stage.harnessArn(agent).split(':');
    const model = models[spec.config.model];
    const profile = `arn:aws:bedrock:${region ?? ''}:${account ?? ''}:inference-profile/${model.modelId}`;
    const role = await roleArn(await stage.executionRoleName(agent));
    const invoke = ['bedrock:InvokeModel'];
    const viaProfile: ContextEntry[] = [
      {
        ContextKeyName: 'bedrock:InferenceProfileArn',
        ContextKeyType: 'string',
        ContextKeyValues: [profile],
      },
    ];
    const own = `arn:aws:bedrock:${region ?? ''}::foundation-model/${model.foundationModel}`;
    const other = `arn:aws:bedrock:${region ?? ''}::foundation-model/anthropic.claude-haiku-5-5`;

    expect(await decisions(role, invoke, profile)).toEqual({ 'bedrock:InvokeModel': 'allowed' });
    expect(await decisions(role, invoke, own, viaProfile)).toEqual({
      'bedrock:InvokeModel': 'allowed',
    });
    expect(await decisions(role, invoke, own)).toEqual({ 'bedrock:InvokeModel': 'implicitDeny' });
    expect(await decisions(role, invoke, other, viaProfile)).toEqual({
      'bedrock:InvokeModel': 'implicitDeny',
    });
    expect(await decisions(role, ['sts:AssumeRole'], '*')).toEqual({
      'sts:AssumeRole': 'explicitDeny',
    });
  });
});
