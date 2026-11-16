import { z } from 'zod';

const modelNames = ['nova-2-lite'] as const;

interface Model {
  readonly modelId: string;
  readonly foundationModel: string;
  readonly usdPerMillionTokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export const models: Record<(typeof modelNames)[number], Model> = {
  'nova-2-lite': {
    modelId: 'global.amazon.nova-2-lite-v1:0',
    foundationModel: 'amazon.nova-2-lite-v1:0',
    // eu-west-2, global cross-Region inference, standard tier (AWS Price List API, 2026-11-15).
    usdPerMillionTokens: { input: 0.42, output: 3.52, cacheRead: 0.105, cacheWrite: 0 },
  },
};

export const nameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]{0,15}$/,
    'must be 1-16 lowercase letters or digits, starting with a letter',
  );

export const agentConfigSchema = z.strictObject({
  model: z.enum(modelNames),
  maxTokens: z.int().min(1).max(8192).default(1024),
  maxIterations: z.int().min(1).max(20).default(5),
  timeoutSeconds: z.int().min(10).max(840).default(120),
  callers: z.array(nameSchema).default([]),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const stageSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]{0,7}$/,
    'stage must be 1-8 lowercase letters or digits, starting with a letter',
  )
  .default('dev');

export const defaultMonthlyBudgetUsd = 5;

export const callersConfigSchema = z.record(
  nameSchema,
  z.strictObject({ monthlyBudgetUsd: z.number().min(0).max(1000) }),
);

export type CallersConfig = z.infer<typeof callersConfigSchema>;
