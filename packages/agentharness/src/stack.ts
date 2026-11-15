import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Agent } from './agent.js';
import { Api } from './api.js';
import { Auth } from './auth.js';
import type { AgentSpec } from './load.js';
import { outputKeys, stackNames } from './names.js';
import { defaultMonthlyBudgetUsd, type CallersConfig } from './schema.js';
import { toMicros } from './spend.js';

export interface StageProps extends StackProps {
  readonly stage: string;
  readonly agents: readonly AgentSpec[];
}

export interface AuthStackProps extends StageProps {
  readonly callers: CallersConfig;
}

export class AuthStack extends Stack {
  readonly auth: Auth;
  readonly api: Api;

  constructor(scope: Construct, { stage, agents, callers, ...props }: AuthStackProps) {
    super(scope, stackNames.auth(stage), {
      description: 'Long-lived access to agentharness agents: callers and the front door.',
      terminationProtection: true,
      ...props,
    });
    Tags.of(this).add('stage', stage);

    this.auth = new Auth(this, 'Auth', { agents });
    this.api = new Api(this, 'Api', {
      stage,
      userPool: this.auth.userPool,
      scopes: this.auth.scopes,
      grants: [...this.auth.clients].map(([caller, { client, agents: allowed }]) => [
        client.userPoolClientId,
        {
          caller,
          agents: allowed,
          budgetMicros: toMicros(callers[caller]?.monthlyBudgetUsd ?? defaultMonthlyBudgetUsd),
        },
      ]),
      limits: Object.fromEntries(
        agents.map(({ name, config: { model, maxTokens, maxIterations } }) => [
          name,
          { model, maxTokens, maxIterations },
        ]),
      ),
    });

    new CfnOutput(this, outputKeys.userPoolId, { value: this.auth.userPool.userPoolId });
    new CfnOutput(this, outputKeys.apiUrl, { value: this.api.url });
    new CfnOutput(this, outputKeys.ledgerTable, { value: this.api.ledger.tableName });
    for (const [caller, { client }] of this.auth.clients) {
      new CfnOutput(this, outputKeys.clientId(caller), { value: client.userPoolClientId });
    }
  }
}

export class AgentsStack extends Stack {
  constructor(scope: Construct, { stage, agents, ...props }: StageProps) {
    super(scope, stackNames.agents(stage), props);
    Tags.of(this).add('stage', stage);

    for (const spec of agents) {
      const agent = new Agent(this, spec.name, { spec, stage });
      Tags.of(agent).add('agent', spec.name);
      new CfnOutput(this, outputKeys.harnessArn(spec.name), { value: agent.harness.attrArn });

      const { knowledge } = agent;
      if (knowledge === undefined) continue;
      new CfnOutput(this, outputKeys.knowledgeBucket(spec.name), {
        value: knowledge.bucket.bucketName,
      });
      new CfnOutput(this, outputKeys.knowledgeBaseId(spec.name), {
        value: knowledge.knowledgeBase.attrKnowledgeBaseId,
      });
      new CfnOutput(this, outputKeys.dataSourceId(spec.name), {
        value: knowledge.dataSource.attrDataSourceId,
      });
    }
  }
}
