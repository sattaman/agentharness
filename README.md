# agentharness

**A folder is an agent.** Describe an agent with three files and deploy it to Amazon Bedrock AgentCore with AWS CDK. No agent code, no containers, no API keys.

```
agents/
└── helper/
    ├── agent.json     # model and limits
    ├── prompt.md      # system prompt
    └── knowledge/     # documents the agent can search (optional)
```

> **Status:** early development. The plan is in [docs/plan.md](docs/plan.md) and the design decisions are in [docs/decisions.md](docs/decisions.md).

## Repo layout

| Path                     | What it is                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `packages/agentharness/` | The npm package: CDK constructs and the `agentharness` CLI                 |
| `examples/helper/`       | A complete example, laid out exactly like a user's own repo                |
| `ops/cleanup/`           | Separate app that deletes dev stacks every night (maintainer account only) |
| `docs/`                  | Decisions, plan, research and one-off AWS setup                            |

## Develop

Requires Node 24 and pnpm (`corepack enable`).

```bash
pnpm install
pnpm check      # format, build, typecheck, lint, test
```

## Deploy and chat

Needs an AWS account set up as described in [docs/setup.md](docs/setup.md).

```bash
pnpm build
cd examples/helper
pnpm deploy              # agentharness-dev-auth (credentials, long-lived) + agentharness-dev-agents
pnpm chat helper         # streams answers, authenticated with a one-hour OAuth token
pnpm get-token           # print a token to call the agent yourself
pnpm destroy             # removes the agents; credentials stay
```

Add `-- -c stage=<name>` to any command for another stage.
