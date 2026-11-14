# Architecture decisions

Short decision records. Newest decisions supersede older ones; superseded entries are kept so the reasoning is visible.

Research backing each decision: [research-2026-11.md](research-2026-11.md). Setup steps: [setup.md](setup.md).

---

## D1 — Convention over configuration

**Decision:** A user touches only three things:

```
agent/
├── agent.yaml    # name, model, limits, budget
├── prompt.md     # system prompt
└── knowledge/    # docs → RAG (folder absent = no knowledge base)
```

Everything else (infra, IAM, monitoring) is derived by CDK. The folder layout was refined in D12 (`agent.json` instead of `agent.yaml`).
**Why:** It's easy to use, easy to explain, and every file maps 1:1 to an AWS resource.

## D2 — TypeScript everywhere

CDK, scripts and any future runtime code are all TypeScript, so there is one toolchain.

## D3 — Phasing

- **Phase 1:** a chat agent that answers from a knowledge base, used through a terminal chat script. No frontend.
- **Phase 2:** an AG-UI web frontend, plus a cost-reporting agent that uses a Cost Explorer tool.

**Why:** It ships something deployable early, and each phase teaches one area.

## D4 — Runtime: AgentCore Harness (no agent code)

**Decision:** Use `AWS::BedrockAgentCore::Harness` (CDK L1 `CfnHarness`). AWS runs the agent loop (built on Strands).
**Mapping:**

- `prompt.md` → `systemPrompt`
- `agent.yaml` → `model` + `maxIterations` / `maxTokens` / `timeoutSeconds`

**Alternatives considered:**

- Calling Bedrock directly with a hand-written loop: best for learning, but more code to own.
- Strands TS in AgentCore Runtime: the framework supplies the loop, but you host a container. That needs Docker, and Express code to maintain.

**Why Harness:** It turns the convention idea into config only. There's no Harness charge (you pay for the underlying compute, tokens and logs). It went GA on 2026-06-17.
**Trade-off:** AG-UI isn't documented for Harness, so phase 2 may need an adapter or a Runtime-hosted UI agent.

## D5 — Model: Amazon Nova 2 Lite

**Decision:** Use `global.amazon.nova-2-lite-v1:0`, with `apiFormat: converse_stream`.
**Why:**

- Harness accepts any Bedrock model through Converse.
- Amazon models need no Marketplace subscription and are enabled on first call.
- It does tool calling and has a 1M-token context window.
- It's cheap: about $0.30 / $2.50 per million input/output tokens. That's an aggregator figure, not yet checked on AWS pricing.

**Cheaper alternative:** Nova Micro.

**Region (2026-11-14):** eu-west-2 (London) is the home region. Every AgentCore service, Managed KB, the Gateway KB connector, Titan V2 and S3 Vectors are available there.

- Nova 2 Lite has **no in-region or `eu.` access from London**. It works only through `global.`, so inference may run outside the UK/EU. That's acceptable for non-sensitive demo docs.
- **For UK-only processing:** switch `agent.yaml` to Nova Micro, which runs in-region in London (weaker at tool use, and no cross-region capacity).
- IAM must allow the foundation-model ARN in all regions (`arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0`). Any region-restriction policy must exempt Bedrock.
  **Superseded:** Claude Haiku 5.5. It's confirmed only through the Bedrock Mantle (Messages API) endpoint; Converse support was unverified, and Harness uses Converse.

## D6 — Knowledge base: Bedrock Managed KB + Gateway built-in connector

**Decision:**

- `knowledge/` → S3 → `AWS::Bedrock::KnowledgeBase` (type `MANAGED`), with an S3 data source of type `MANAGED_KNOWLEDGE_BASE_CONNECTOR`.
- The KB is exposed through AgentCore Gateway's built-in `bedrock-knowledge-bases` connector target (`Retrieve` tool), with outbound auth `GATEWAY_IAM_ROLE`.
- Harness connects to the Gateway as an `agentcore_gateway` tool with `awsIam` outbound auth.

**Why:** No Lambda and no vector store to manage. IAM is used end to end, so there's no Cognito or API keys.
**Superseded:** S3 Vectors + Titan v2 + a custom Lambda `search_knowledge` tool. A classic vector KB needs a Lambda target.
**Note:** Deploying does not start ingestion, so a custom resource calls `StartIngestionJob`.

## D7 — CDK library: plain aws-cdk-lib

**Decision:** Use aws-cdk-lib 2.277.0: `CfnHarness` (L1), the Gateway L2, and the KB as L1.
**Not chosen:** `@aws/agentcore-cdk` (L3 constructs). It imposes the agentcore CLI's `agentcore.json` schema instead of our convention.

## D8 — Security baseline

- No long-lived keys. Use `aws login` locally, and IAM roles everywhere else.
- Least-privilege roles (see research §IAM).
- Lock down Harness:
  - Pin `model` and `systemPrompt`.
  - List `allowedTools` explicitly. Omitting it grants shell and file tools.
  - Disable memory for v1.
  - Never pass caller-supplied overrides through.
- Run `cdk bootstrap` with scoped `--cloudformation-execution-policies` (not AdministratorAccess) and `--termination-protection`.
- Run cdk-nag 3.0.2 at synth. Findings fail the build.

## D9 — Cost monitoring baseline

- Put a `project=<name>` tag on every resource, and activate it as a cost allocation tag immediately. Activation takes about 48h and doesn't apply to earlier costs.
- Create an AWS Budget with email alerts before the first deploy.
- Add Cost Anomaly Detection (free).
- Use Harness `metadata` stream events (token usage) and CloudWatch GenAI Observability for near-real-time usage.

## D10 — Toolchain

- **Node:** Node 24 (Lambda `nodejs24.x` is GA; `nodejs26.x` is still in preview).
- **CDK CLI:** a project devDependency, run via `npx`.
- **Docker:** not needed. Lambdas, if any, are bundled locally with esbuild.
- **AWS CLI:** ≥ 2.35.7.

## D11 — Who can do what (identities and guardrails)

| Identity          | Used by                     | Credentials                                            | Can do                                                                  |
| ----------------- | --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Root              | Owner, rarely               | Password + MFA, no access keys                         | Account-level tasks only                                                |
| Admin (IAM user)  | Owner                       | Console + MFA; `aws login`, signed out when not in use | Everything                                                              |
| Developer         | Day-to-day work, AI tooling | Console + MFA; `aws login` with a separate profile     | `PowerUserAccess` + `IAMReadOnlyAccess`, minus the developer guardrails |
| CDK cfn-exec role | CloudFormation              | Assumed by the service                                 | Capped by the permissions boundary                                      |

- **Developer guardrails** ([iam/developer-guardrails.json](iam/developer-guardrails.json)):
  - Can only assume the CDK bootstrap roles (`cdk-hnb659fds-*`).
  - No account, billing or org changes, and no edits to budgets, anomaly monitors or CloudTrail.
  - No irreversible purchases or Marketplace subscriptions.
  - Can't delete the CDK bootstrap stack.
  - Can't touch other workloads' resources in a shared account (`OTHER-WORKLOAD-*` placeholder).
- **Permissions boundary** ([iam/boundary.json](iam/boundary.json)):
  - Applied to the cfn-exec role (`cdk bootstrap --custom-permissions-boundary`) and to every role the stacks create, through CDK's standard `@aws-cdk/core:permissionsBoundary` context in the user's `~/.cdk.json`. The kit has no boundary setting of its own.
  - Every new role or user must carry the boundary, and the boundary can't be edited or removed.
  - The guardrail denies are repeated in the boundary, so a stack can't do indirectly what the developer can't do directly.
  - **Consequence:** budgets are managed by hand, not by CDK.
- **Budget access stop:** when the monthly budget threshold is hit, a budget action attaches a deny-all policy to the developer identity. This stops new actions; it does not stop resources that are already running (see the plan's teardown runbook).
- **Account-specific values** (profile names, region, boundary name) live outside the repo: `~/.cdk.json`, `~/.aws/config`, and gitignored files such as `.claude/settings.local.json`.
- **Verified** with `iam simulate-principal-policy`:
  - Denied as intended: IAM user and key creation, budget edits, purchases, other-workload deletes, assuming other roles, and roles without the boundary.
  - Allowed as intended: CDK deploy role, S3, Lambda, Bedrock.

## D12 — Name and repo structure

- **Name:** `agentharness`, used for the repo, the npm package and the CLI. "AgentCore Harness" always means the AWS resource. "agentcore" isn't used as a name, because it's AWS's product name.
- **Monorepo** (pnpm workspaces):

```
packages/agentharness/   the one published package: CDK constructs + `agentharness` CLI
examples/helper/         exactly what a user's repo looks like
docs/
```

- The example depends on `"agentharness": "workspace:*"`, so it can only use the published API.
- **Users write no code.** Their repo holds `agents/<name>/`, `package.json` and a `cdk.json` containing `{ "app": "npx agentharness synth" }`. The exported construct is available for adding agents to an existing CDK app.
- **Agent folder:** `agent.json` + `prompt.md` + `knowledge/`. JSON with no `$schema` line. Editors get the schema through `.vscode/settings.json` `json.schemas` (later through SchemaStore). The CLI validates against the same zod schema either way.
- **Resource names:** stacks `agentharness-<stage>-auth` and `agentharness-<stage>-agents`; resources `agentharness-<stage>-<agent>-*`; AgentCore Harness `agentharness_<stage>_<agent>`. Tags: `project`, `stage`, `agent`.

## D13 — Git conventions

- `main` is protected. Work happens on short-lived branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- PRs are squash-merged, so history is linear and each PR is one commit.
- Conventional Commits, enforced on the PR title (which becomes the squash commit), not by local hooks.
- Releases are tags like `v0.1.0`.
- Code comments are minimal. Names and structure explain the code; a comment is kept only for a non-obvious _why_.

## D14 — TypeScript setup

- TypeScript 6.0 (typescript-eslint doesn't support 7 yet; revisit when it does), strict plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and related flags.
- ESLint with typed, assertion-hostile rules (`strictTypeChecked`, no `as` assertions, no `!`). Prettier for formatting. Vitest for tests.
- `skipLibCheck` is on only because aws-cdk-lib's declarations don't compile under `exactOptionalPropertyTypes`.

## D15 — Calling an agent: machine-to-machine OAuth tokens

- **Two stacks per stage.** `agentharness-<stage>-auth` holds a Cognito user pool with one app client. It's long-lived and has termination protection. `agentharness-<stage>-agents` holds the agents. It comes and goes (deleted nightly in dev) and references the auth stack with strong cross-stack references, so the auth stack can't be changed or deleted underneath it.
- **Stable credentials, short-lived tokens.** The client ID and secret stay the same across agent redeploys. Tokens are JWT access tokens valid for 1 hour. AgentCore accepts JWTs or SigV4, never static API keys, so a non-expiring token isn't possible, by design.
- **Client-token flow.** The app client has a secret, the `client_credentials` OAuth flow and the `agentharness/invoke` scope, and `ALLOW_CLIENT_TOKEN_AUTH` as its _only_ auth flow, which cannot sign users in. `GetClientToken` (August 2026) issues tokens without a hosted domain.
- **The authorizer config lives in one place.** Every Harness gets `Auth.jwtAuthorizer`: discovery URL, allowed client and required scope. Cognito access tokens have no `aud` claim, so it checks the client rather than the audience.
- **Secret delivery.** The CLI reads the secret with the caller's IAM credentials (`DescribeUserPoolClient`) and exchanges it for a token, so only someone with IAM access can mint tokens. It never appears in stack outputs. When an external caller needs it, store it in Secrets Manager.
- **Trust boundary.** A token holder can override the system prompt and model per request. IAM limits the execution role to the configured model, and the Harness has no tools, so the damage is limited to off-task answers and token spend. Treat tokens as trusted-caller credentials.
- **Cost.** About $0.002–0.003 per token request. The CLI reuses a token until a minute before it expires.
- **Later:** one client per consumer (separate revocation and attribution) and per-agent scopes.

## D16 — Nightly cleanup lives outside the kit

- Deleting stacks every night is a safety net for the maintainer's account, not a kit feature, so it's a separate CDK app in `ops/cleanup`, deployed once.
- EventBridge Scheduler calls CloudFormation `DeleteStack` directly (a universal target): no Lambda. There's one schedule per stage, at 02:00 Europe/London.
- The schedule's role can delete only `agentharness-<stage>-agents` stacks, not its own stack (checked with `iam simulate-principal-policy`).
- **Runtime logs.** The Harness creates its log group outside the stack, at creation time, so the stack can neither pre-create nor delete it. An account-level CloudWatch Logs retention policy (November 2026) on the prefix `/aws/bedrock-agentcore/runtimes/harness_agentharness_` keeps them for 30 days with no Lambda. CloudFormation can't create that policy type yet, so it's a one-off command in `setup.md`.
