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
**Versions:** every update creates an immutable Harness version, and the `DEFAULT` endpoint follows the latest. We don't use named endpoints. Stages are separate Harnesses, deleted nightly, so rollback is a git revert and a redeploy. Named endpoints pay off once a single long-lived production Harness exists.

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
**Ingestion (2026-11-15):** a kit command, `agentharness sync`, not part of the deploy. It mirrors `knowledge/` to S3 (deletes included), calls `StartIngestionJob`, waits, and fails naming any document that didn't ingest. `pnpm run deploy` runs `cdk deploy` and then `sync`. CI runs the same command on changes to `knowledge/`.

- **Why not a custom resource:** it would add Lambdas (the kit has none), it starts ingestion without seeing it finish, so failures end up in CloudWatch rather than the deploy, and content would need an infrastructure deploy. Content changes need narrower permissions than deploys (S3 writes and starting ingestion), which fits central approval (plan §12).
- **Not the connector's `SyncSchedule`:** it only runs daily, weekly or monthly, so it doesn't follow changes.

**Scope:** one bucket, KB and Gateway per agent, in the disposable `-agents` stack. Agents can't read each other's knowledge: with IAM auth, a role that can invoke a Gateway reaches every target behind it. The nightly teardown exists to stop spend, so a fresh deploy starting with an empty KB is fine; `sync` fills it.

**Verified on AWS (2026-11-15):**

- The S3 connector requires `bucketOwnerAccountId`, even for a bucket in the same account.
- The KB role needs only `s3:ListBucket` and `s3:GetObject`; managed embeddings need no `bedrock:InvokeModel`.
- `allowedTools: ['@knowledge']` admits the Gateway's tools; the stream names the tool `knowledge___Retrieve`.
- Timings: deploy about 100s, first `sync` about 2.5 minutes, rollback or teardown about 12 minutes (Bedrock deletes the data source slowly).
- The bucket empties itself on delete (`autoDeleteObjects`, CDK's own small Lambda), so nightly teardown doesn't fail on a non-empty bucket. Data-source deletion protection is off, so `sync` deletions always apply; git review guards what is removed.

## D7 — CDK library: plain aws-cdk-lib

**Decision:** Use aws-cdk-lib 2.277.0: `CfnHarness` (L1), the Gateway L2, and the KB as L1.
**Not chosen:** `@aws/agentcore-cdk` (L3 constructs). It imposes the agentcore CLI's `agentcore.json` schema instead of our convention.

## D8 — Security baseline

- No long-lived keys. Use `aws login` locally, and IAM roles everywhere else.
- Least-privilege roles (see research §IAM).
- Give each Harness safe defaults:
  - Set `model` and `systemPrompt`.
  - List `allowedTools` explicitly. Omitting it grants shell and file tools.
  - Disable memory for v1.
  - Set `truncation` to a sliding window (the last 20 messages). The service default summarises old turns, which costs extra model calls and can change.
  - Set the top-level `maxTokens`, which is the budget for a whole invocation. The model's `maxTokens` limits only a single model call.
  - Keep an idle session warm for at most 300 s (the default is 900 s, billed for memory) and end it after 3600 s. Callers can't override these.
  - These are defaults, not limits: callers can override them per request (D15). What an agent can do in AWS is limited by its execution role.
  - Never forward caller-supplied overrides.
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
- Conventional Commits, enforced on the PR title (which becomes the squash commit).
- A pre-commit hook (`.githooks/pre-commit`, installed by `pnpm install`) runs the format check, typecheck, lint with zero warnings, and gitleaks. CI runs the full `pnpm check`. The hook catches problems before they reach a commit, and CI catches anything committed with `--no-verify`.
- `.vscode/settings.json` makes the editor use the workspace TypeScript, so editor diagnostics match the command line.
- Releases are tags like `v0.1.0`.
- Code comments are minimal. Names and structure explain the code; a comment is kept only for a non-obvious _why_.

## D14 — TypeScript setup

- TypeScript 6.0 (typescript-eslint doesn't support 7 yet; revisit when it does), strict plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and related flags.
- ESLint with typed, assertion-hostile rules (`strictTypeChecked`, no `as` assertions, no `!`). Prettier for formatting. Vitest for tests.
- `skipLibCheck` is on only because aws-cdk-lib's declarations don't compile under `exactOptionalPropertyTypes`.

## D15 — Calling an agent: machine-to-machine OAuth tokens

**Superseded in part by D17 (2026-11-15):** tokens now authorize the front door, not the Harness, and Harnesses accept SigV4 only. The token flow, secret delivery and trust-boundary findings below still hold.

- **Two stacks per stage.** `agentharness-<stage>-auth` holds a Cognito user pool with one app client. It's long-lived and has termination protection. `agentharness-<stage>-agents` holds the agents. It comes and goes (deleted nightly in dev) and references the auth stack with strong cross-stack references, so the auth stack can't be changed or deleted underneath it.
- **Stable credentials, short-lived tokens.** The client ID and secret stay the same across agent redeploys. Tokens are JWT access tokens valid for 1 hour. AgentCore accepts JWTs or SigV4, never static API keys, so a non-expiring token isn't possible, by design.
- **Client-token flow.** The app client has a secret, the `client_credentials` OAuth flow and the `agentharness/invoke` scope, and `ALLOW_CLIENT_TOKEN_AUTH` as its _only_ auth flow, which cannot sign users in. `GetClientToken` (August 2026) issues tokens without a hosted domain.
- **The authorizer config lives in one place.** Every Harness gets `Auth.jwtAuthorizer`: discovery URL, allowed client and required scope. Cognito access tokens have no `aud` claim, so it checks the client rather than the audience.
- **Secret delivery.** The CLI reads the secret with the caller's IAM credentials (`DescribeUserPoolClient`) and exchanges it for a token. IAM protects _reading_ the secret. Anyone who holds it can mint tokens, because `GetClientToken` isn't IAM-authorized. So it never appears in stack outputs. When an external caller needs it, store it in Secrets Manager.
- **Trust boundary (checked against the AWS Harness security docs, 2026-11-15).** A token gives full control of the agent's session:
  - Per request, a caller can override the model, system prompt, tools, `allowedTools`, skills and limits. `allowedTools: ["*"]` turns on the built-in shell, file and web tools, and sessions have public network access. There is no setting to turn overrides off.
  - A token can also open an interactive shell in the session, or run commands directly. Both run as root in the microVM, and `allowedTools` doesn't apply to them. For token callers, the authorizer is the only gate.
  - Through `model.additionalParams`, a caller can send the model request, signed with the execution role's session credentials, to an endpoint they choose. So the role's credentials can leak.
  - One client can call every agent in its stage.
  - What _is_ enforced is the execution role, which is why it is kept tight. It can call the configured inference profile only (direct foundation-model calls require `bedrock:InferenceProfileArn`), can reach its own gateway only, and is denied `sts:AssumeRole`. Leaked credentials can do no more than that.
  - **Verified live (2026-11-15):** with `allowedTools: ["*"]`, a token caller got the model to run shell commands as `uid=0(root)` with outbound HTTPS working. Overriding the model to another Bedrock model failed with `AccessDeniedException` from the execution role.
  - So tokens are for trusted maintainers. Before anyone untrusted gets access, a validating layer must sit in front of the Harness (plan §8).
- **Cost.** About $0.002–0.003 per token request. The CLI reuses a token until a minute before it expires.
- **Later:** one client per consumer (separate revocation and attribution) and per-agent scopes.

## D16 — Nightly cleanup lives outside the kit

- Deleting stacks every night is a safety net for the maintainer's account, not a kit feature, so it's a separate CDK app in `ops/cleanup`, deployed once.
- EventBridge Scheduler calls CloudFormation `DeleteStack` directly (a universal target): no Lambda. There's one schedule per stage, at 02:00 Europe/London.
- The schedule's role can delete only `agentharness-<stage>-agents` stacks, not its own stack (checked with `iam simulate-principal-policy`). CloudFormation performs the deletion with the stack's own role, which is why the schedule needs nothing more.
- A successful schedule run means deletion was _requested_. The runbook checks that the stack reached `DELETE_COMPLETE`.
- **Runtime logs.** The Harness creates its log group outside the stack, at creation time, so the stack can neither pre-create nor delete it. An account-level CloudWatch Logs retention policy (November 2026) on the prefix `/aws/bedrock-agentcore/runtimes/harness_agentharness_` keeps them for 30 days with no Lambda. CloudFormation can't create that policy type yet, so it's a one-off command in `setup.md`.

## D17 — One front door for every caller

**Problem:** a token accepted by a Harness gives full control of the session: per-request overrides of model, prompt and tools, and a root shell (D15, verified live). AWS offers no setting to stop this. Its answer is to validate requests in your own layer.

**Decision:** callers never reach a Harness. They call one front door per stage, which builds every request itself.

```
caller ──token──▶ API Gateway ──▶ Lambda ──SigV4──▶ Harness (IAM only)
                  (Cognito,        (validates,
                   scopes)          streams)
```

- **Harnesses accept SigV4 only:** no JWT authorizer. A token sent straight to a Harness is refused.
- **API Gateway** (Regional REST) checks three things before the Lambda runs:
  - the Cognito token;
  - the token has a scope for at least one agent;
  - the body matches the request schema (the same zod schema as the Lambda, converted to JSON Schema).
    It also throttles the stage to 5 requests a second, burst 10.
- **The Lambda** (`handler.ts`, with its logic in `request.ts`):
  - accepts exactly `{ agent, message, sessionId }`;
  - requires the exact scope `agentharness/<agent>` in the token, and that the caller's _current_ grants still include that agent;
  - derives the session from the caller, agent and session ID, so callers can't share or hijack sessions;
  - calls `InvokeHarness` with only the message, and streams replies back as NDJSON;
  - logs the caller, agent, outcome and tokens used, never the message.
- **The Lambda's role** can invoke `harness/agentharness_<stage>_*` and read the agents stack's outputs, and nothing else. It has no command or shell permissions, so nobody can open a shell.
- **Access is declared with the agent:** `"callers": ["support"]` in `agent.json`.
  - Each caller gets its own Cognito client and secret, scoped to the agents that name it. `maintainers` can call every agent.
  - Revoke by removing the caller and redeploying. The Lambda holds the current grants, so a removed grant stops working at once, even with an unexpired token.
- **It lives in the long-lived `-auth` stack.** The Lambda finds Harnesses through the agents stack's outputs, so the two stacks don't reference each other, and the URL survives the nightly teardown.
- **The Lambda ships pre-bundled** in the npm package (`dist/handler`), built with esbuild at package build time, so users need no bundler.

**Why this shape:**

- Harness limits become real limits, because no overrides reach the Harness.
- "Never forward overrides" (D8) is now enforced, not just a guideline.
- Each consumer has its own credentials, revocation and usage.
- Streaming works end to end: API Gateway REST APIs stream Lambda responses for up to 15 minutes (November 2025).

**Not chosen:**

- **Apigee or another external gateway:** it would need AWS signing, which means long-lived keys or cross-cloud federation. One can still sit in front of this front door.
- **API Gateway calling AgentCore directly:** mapping templates, no streaming, no metering.
- **An AgentCore Runtime agent as the front door:** a bearer token could open a shell inside it, where the Harness-invoking credentials live.
- **A Lambda function URL:** JWT checks would move into code, and unauthenticated requests would still invoke, and bill, the function.

**Verified live (2026-11-15):**

| Test                                  | Result                                             |
| ------------------------------------- | -------------------------------------------------- |
| No token                              | 401                                                |
| An extra field such as `allowedTools` | 400                                                |
| An agent the caller isn't granted     | 403                                                |
| A token sent straight to the Harness  | 403, "use SigV4"                                   |
| A prompt asking for the shell         | Refused by the model, with no shell tool available |
| `maintainers` and `demo` callers      | Answers stream back with retrieval                 |

**Still open:**

- **Prompt injection** and disclosure of an agent's knowledge to its allowed callers. Grant agents only to callers who may see all of their knowledge.
- **Throttling is per stage.** A per-caller quota would go in the Lambda, as an atomic counter.
- **No API Gateway or WAF logs** (cdk-nag acknowledged). The Lambda logs every request that reaches it.
- **Maintainers with IAM access** can still invoke a Harness directly with SigV4, bypassing metering. That is the trusted path.
