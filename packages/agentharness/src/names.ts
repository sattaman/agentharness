export const harnessName = (stage: string, agent: string): string =>
  `agentharness_${stage}_${agent}`;

export const stackNames = {
  auth: (stage: string): string => `agentharness-${stage}-auth`,
  agents: (stage: string): string => `agentharness-${stage}-agents`,
};

export const outputKeys = {
  userPoolId: 'UserPoolId',
  apiUrl: 'ApiUrl',
  ledgerTable: 'LedgerTable',
  clientId: (caller: string): string => `${caller}ClientId`,
  harnessArn: (agent: string): string => `${agent}HarnessArn`,
  knowledgeBucket: (agent: string): string => `${agent}KnowledgeBucket`,
  knowledgeBaseId: (agent: string): string => `${agent}KnowledgeBaseId`,
  dataSourceId: (agent: string): string => `${agent}DataSourceId`,
};

export const maintainers = 'maintainers';

export const frontDoorRoleName = (stage: string, region: string): string =>
  `agentharness-${stage}-frontdoor-${region}`;
