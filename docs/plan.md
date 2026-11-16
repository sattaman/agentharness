# Plan: MVP, CI, deployment and safety

Status: **agreed**, 2026-11-14. **M1 done** (deployed and verified 2026-11-14), plus bearer-token auth (D15) and nightly cleanup (D16). Revised after an external review (Codex); the changes are listed in §10. Revised again on 2026-11-15 after checking the AgentCore Harness security docs; see §13. Naming, structure and git conventions are recorded in [decisions.md](decisions.md) D12–D14.

---

## 1. Naming

`agentharness` for the repo, the npm package and the CLI. See D12 for the full naming table.

## 2. Public repo hygiene: what must never be committed

The repo isn't a git repo yet, so the first commit can be clean and there's no history to rewrite.

**Never in the repo:**

- AWS account IDs and ARNs that contain them.
- IAM user, profile and budget names.
- Names of other projects in the account.
- Email addresses.
- The real OIDC role ARN.
- `cdk.context.json`, which caches account-specific lookups.

**How:**

- **Account-specific config goes in gitignored files:**
  - `.claude/settings.local.json`: `AWS_PROFILE`, plus the deny rules that name the admin profile.
  - `local/`: the filled-in IAM policies and anything else account-specific.
- **Committed files use placeholders:** `.claude/settings.json`, `docs/`, and `docs/iam/*.json` (with `OTHER-WORKLOAD-*` and `agentharness-boundary`).
- **The account comes from the environment:** CDK reads it from `CDK_DEFAULT_ACCOUNT`. The CI role ARN is stored as a GitHub _environment variable_, not in a file.
- **Scanning:**
  - `gitleaks` in CI and before every commit (`.gitleaks.toml`).
  - Custom rules for account IDs in ARNs and in `account: 123…` style assignments.
  - GitHub secret scanning and push protection turned on.
- **Rewrite the existing docs before the first commit.** D11 and `setup.md` mention user, profile, budget and other-project names. Make them generic: "admin identity", "developer identity", "protected resources".

## 3. The MVP journey

**MVP definition:** someone clones the repo, follows the README, and within about 15 minutes has a knowledge-base agent deployed in **their own** AWS account and is chatting with it in the terminal. The same flow runs automatically in our CI on every merge to main.

What the user does:

```bash
git clone … && cd agentharness && pnpm install && pnpm build
# edit examples/helper/agents/helper/{agent.json,prompt.md,knowledge/*.md}
pnpm --dir examples/helper check               # validate conventions offline, with readable errors
pnpm --dir examples/helper deploy -- -c stage=dev
pnpm chat helper                               # test client (tools/chat), with a token from the README steps
pnpm --dir examples/helper destroy             # clean teardown (including the KB and S3)
```

Each script calls the `agentharness` CLI or `cdk`. The 15-minute target starts _after_ the one-off account setup and `cdk bootstrap`, which `docs/setup.md` documents separately.

After the MVP, users install `agentharness` from npm into their own repo, laid out like `examples/helper`.

### Milestones

Each milestone ends with something that runs.

| #     | Milestone                                                                                                                                                           | Done when                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0    | **Repo hygiene and offline CI**: rename, scrub the docs, `git init`, gitleaks, lint/format, Vitest, monorepo layout, **`pr.yml`**, a minimal README                 | First commit passes the leak scan; PR checks are green and required on `main`; nothing account-specific is tracked                                            |
| M0.5  | **Cost estimate**: a London-region estimate for Harness/Runtime, Gateway, Managed KB (storage + retrieval), tokens and logs; set the KB size cap and the CI budget  | The numbers are in `docs/cost.md`; §9 Q3 is answered with data                                                                                                |
| M1    | **Walking skeleton**: a hand-written stack with one `CfnHarness` (no KB) and a chat script                                                                          | Deployed to a personal stage; we get a streamed answer; destroy works and leaves nothing behind. _This de-risks the newest, least-documented resource first._ |
| M2    | **Loader**: folder → `AgentSpec` (zod), with fixtures for valid and invalid cases                                                                                   | Unit tests cover every rule. M1's hard-coded values now come from `agent.json` / `prompt.md`                                                                  |
| M3 ✅ | **Knowledge base** (cost check waits for M0.5): Per agent: S3 bucket, Managed KB, Gateway KB connector, Harness tool wiring; `agentharness sync` for ingestion (D6) | The chat answers a question whose answer exists only in `knowledge/`; the stream shows a `Retrieve` tool event. Measured cost matches M0.5                    |
| M4    | **Construct API and synth tests**: the `Agents` construct and `agentharness synth` discovering `agents/*/`; template assertions; cdk-nag clean                      | The example contains no code; README walkthrough works from a clean clone                                                                                     |
| M5    | **Dedicated AWS account + CI OIDC role** (see §8)                                                                                                                   | The role can deploy only in the new account; a run from a non-`main` branch is shown to fail to get credentials                                               |
| M6    | **CI: deploy and smoke test**, manually approved                                                                                                                    | Approving a run deploys `stage=ci`, the smoke test passes, the job summary shows the result and token count, and the stage is torn down                       |
| M7    | **Docs and release**: demo GIF, architecture diagram, security and cost sections; publish `agentharness@0.1.0` via npm trusted publishing                           | `npm pack` contents are reviewed; a stranger can follow the README                                                                                            |

**Out of the MVP** (phase 2): web UI (AG-UI), the cost-reporter agent, a `create-agentharness` starter, evals, multiple regions, memory.

## 4. Repo layout

See D12. Each concept gets one file in `packages/agentharness/src/` (for example `load.ts`, `schema.ts`, `agents.ts`, `knowledge.ts`, `api.ts`, `cli.ts`), and only `index.ts` and `cli.ts` are public.

- `aws-cdk-lib` and `constructs` are **peerDependencies** of `agentharness`.
- Every stack takes a `stage` (default `dev`, validated as `[a-z][a-z0-9]{0,7}`). Stack names include it, so personal and CI stacks never collide. Stages are at most 8 characters and agent names at most 16, so the Harness name `agentharness_<stage>_<agent>` stays within AgentCore's 40-character limit.

## 5. Testing strategy

**Status (2026-11-15):** unit, synth and live tests are built. 69 run in CI on every PR (and in `pnpm check`); the pre-commit hook runs the format check, typecheck, lint and gitleaks. 10 live tests run with `pnpm smoke` against a deployed stage.

| Layer                   | What it proves                                                                                                                                                                                                                                                                                       | Where                        | AWS?             | Runs                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------- | ------------------------------------- |
| **Unit**                | Loader and schema rules; request rules (strict body, exact scope, current grants, sessions bound to the caller); spend maths; every front-door decision: rejection order, reserve and settle, failed or unmetered calls keeping the reservation, disconnects, no message in logs                     | `packages/agentharness/test` | No               | Every PR, and `pnpm check`            |
| **Synth**               | Resource shape and security properties: Harnesses without an authorizer, the front-door role's exact actions, per-agent scopes, streaming, a retained ledger, the fixed role name. cdk-nag has zero unjustified findings                                                                             | `stack.test.ts`              | No               | Every PR, and `pnpm check`            |
| **Live**                | Answers from knowledge, with a `Retrieve` event; 401, 400 and 403 at the front door; a token sent straight to a Harness → 403; a model override denied by IAM; the ledger equal to the summed costs of concurrent calls; 429 one micro-dollar past the budget boundary; IAM simulation of both roles | `tools/smoke`                | Yes, about $0.01 | `pnpm smoke`; in CI after deploy (M6) |
| **Adversarial** (to do) | A planted "ignore your instructions" document; the agent still answers and doesn't echo it                                                                                                                                                                                                           | `tools/smoke`                | Yes              | With smoke                            |
| **Lifecycle** (to do)   | Edit or delete a knowledge file, then `sync` re-ingests it; a failed ingestion fails `sync` with the file name; `destroy` leaves nothing behind                                                                                                                                                      | Script                       | Yes              | Before M7                             |
| **Evals** (phase 2)     | `agents/<name>/evals.json` plus an LLM judge                                                                                                                                                                                                                                                         | —                            | Yes              | Nightly, or by hand                   |

The smoke test checks for facts, not exact wording. The golden fact is a made-up token planted in `knowledge/` (for example "the office plant is called Ferngus") and appears nowhere else (not in the prompt). The text check alone doesn't prove retrieval, which is why the tool event is asserted as well. Snapshot tests were dropped: they churn with every CDK upgrade and duplicate the targeted assertions.

## 6. CI design

### `pr.yml`: every PR and every push to any branch

- **Permissions:** `contents: read` only. **No AWS credentials and no `id-token`.**
- **Steps:**
  1. Checkout.
  2. pnpm install `--frozen-lockfile`.
  3. Typecheck, lint, unit tests, synth tests.
  4. `cdk synth` of the example (this runs cdk-nag).
  5. gitleaks.
  6. `pnpm audit --prod`.
- Triggered by `pull_request` (**never `pull_request_target`**), so fork PRs run without secrets. Workflows from first-time contributors need approval to run.

### `deploy.yml`: push to `main` and `workflow_dispatch`

- **One job runs in the GitHub `environment: aws-ci`.**
  - The environment has deployment branch rules (`main` only).
  - Optionally a required reviewer (you), which acts as a manual "approve spend" gate.
- **Permissions:** `id-token: write`, `contents: read`.
- **Steps:**
  1. `aws-actions/configure-aws-credentials` (pinned by SHA) assumes the CI role through OIDC.
  2. `cdk deploy --require-approval never -c stage=ci`.
  3. Smoke test.
  4. Write a job summary (pass/fail, the golden question, tokens, estimated cost). The full answer is shown only because `knowledge/` holds public demo content.
  5. `cdk destroy` (`if: always()`).
- **Triggers:** `workflow_dispatch`, plus push to `main` behind a **required reviewer** on the environment. Nothing deploys without your approval.
- `concurrency: deploy-ci` (no cancel-in-progress), so two deploys never race.
- **Teardown:** destroy after every run to begin with. Keep a stage up as a live demo only once the measured idle cost (M0.5/M3) is acceptable.
- Installs use `--frozen-lockfile`, and install scripts are allowed only for listed packages (`allowBuilds`).

### `release.yml`: tags or Changesets

- npm **trusted publishing** (OIDC, no `NPM_TOKEN`). Provenance is automatic.
- Needs `id-token: write`, a recent npm CLI, and `repository.url` in `package.json` that matches the GitHub repo.
- Run `npm pack --dry-run` and review the file list before the first release.
- Publish an early `0.0.x` placeholder of `agentharness` to hold the name.

### Supply chain (all workflows)

- Third-party actions pinned to full commit SHAs.
- Renovate or Dependabot to bump them.
- `CODEOWNERS`, branch protection on `main` (PR required, checks required, no force-push), and signed commits optional.

### CI for users

- `docs/ci.md` provides the same two workflows as copy-paste templates, plus a CloudFormation/CLI snippet to create _their_ OIDC provider and role.
- Bad conventions fail at `check` / `synth` with readable errors, before anything touches AWS.

## 7. Where we see a working deployment

1. **Personal stage** (`stage=dev`) in your account, through the test client `pnpm chat` (`tools/chat`). This is the development loop.
2. **CI stage** (`stage=ci`). Every merge to main redeploys it and posts a **GitHub Actions job summary** with a real Q&A transcript and token cost. That's public, verifiable proof that it works, without exposing an endpoint.
3. **README**: a short recorded demo (asciinema or GIF) plus a link to the latest green deploy run.
4. **No public endpoint in the MVP.** An unauthenticated chat URL is a cost and abuse risk. Phase 2 can add a web UI behind Cognito with an invite-only user pool, plus per-user rate limits, if a live demo for reviewers is wanted.

## 8. Security and safety while we build

### Account and identity (keeps D11, made generic)

- **Three identities, no long-lived keys anywhere:**
  - Admin: human, MFA, signed out when not in use.
  - Developer (Claude Code): power user, minus guardrails.
  - CI: OIDC role.
- **Dedicated AWS account before any CI trust (M5).** Today the CloudFormation execution role is `AdministratorAccess` capped by a boundary that mostly allows `*` minus a list of denies. That's acceptable for a human-driven laptop deploy. It isn't acceptable for a role that GitHub can assume, in an account shared with another project. So:
  - Create a member account under Organizations, just for this project. That's the real blast-radius boundary.
  - Re-bootstrap it with a **scoped execution policy** (`--cloudformation-execution-policies`) covering only the services the kit uses (Bedrock / AgentCore, S3, IAM roles with the boundary, Lambda, Logs, CloudWatch), not AdministratorAccess.
  - Local development can move to the new account at the same time.
- **New: the CI OIDC role** (in the new account). Created by hand by the admin, the same way as the boundary (the CDK stacks never manage their own deploy trust).
  - **Trust:** `token.actions.githubusercontent.com`, `aud=sts.amazonaws.com`, `sub=repo:<owner>/agentharness:environment:aws-ci`. That's exact, with no wildcards.
  - The `sub` names the _environment_, not the branch. So the branch restriction comes from the environment's settings: deployment branches = `main` only, a required reviewer, and admins can't bypass. **Test it:** a dispatch from another branch must fail to get credentials.
  - **Permissions:** `sts:AssumeRole` only, on that account's CDK bootstrap roles (`cdk-hnb659fds-{deploy,file-publishing,lookup}-role-<acct>-<region>`), plus `bedrock-agentcore:InvokeHarness` and read-only CloudFormation/logs for the smoke test.
  - Carries the permissions boundary. Max session 1h.
- **The budget action is an access stop, not a spend cap.** Denying the developer and CI identities stops _new_ deploys and calls by them. It doesn't stop token callers or the agents' execution roles, or resources that are already running. Budgets refresh only every 8–12 hours, and billing data lags on top of that. To actually limit spend:
  - Service quotas, and the KB size cap. The Harness limits (tokens, iterations, timeout) are defaults that a token holder can raise.
  - Destroy-after-run in CI, and the nightly cleanup (D16).
  - A tested **emergency runbook** (`docs/runbook.md`), run by the admin:
    1. Attach a deny on `bedrock:InvokeModel*` to every agentharness execution role. This is instant.
    2. Destroy all `agentharness-*-agents` stacks and confirm `DELETE_COMPLETE`.
    3. Check with the Resource Groups tag API that no tagged resources remain.
  - The `-auth` stacks survive, so recovery is a redeploy.

### What the stacks create (enforced by synth tests)

- Least-privilege roles, all carrying the boundary.
- Harness defaults:
  - Model and system prompt from the agent folder.
  - `allowedTools` explicit (gateway Retrieve only).
  - Memory disabled.
  - `maxIterations`, `maxTokens` and `timeoutSeconds` from `agent.json`, within kit maximums.
  - **A caller can override every one of these** (D15). They're defaults, not limits.
- Execution role (enforced, whatever the caller sends):
  - It can call the configured inference profile only. Direct foundation-model calls require `bedrock:InferenceProfileArn`.
  - It can reach the agent's own gateway only.
  - It is denied `sts:AssumeRole`.
- S3:
  - Block public access.
  - Enforce SSL.
  - SSE (S3-managed keys for the MVP; KMS optional).
  - `RemovalPolicy.DESTROY` + `autoDeleteObjects` only for non-prod stages.
- Logs: retention set (for example 30 days), so nothing is kept forever.
- **Inbound: one front door per stage (D17).**
  - Callers use a token for their own Cognito client. The front door builds every request, so no overrides reach a Harness.
  - Harnesses accept SigV4 only, and the front door's role can't open shells.
  - Access is declared per agent (`callers` in `agent.json`) and reviewed in the same PR.
- **Later hardening:**
  - a per-caller quota in the front door;
  - WAF;
  - a `beforeToolCall` hook as a tool allowlist (callers can't override hooks);
  - VPC mode to limit network egress.
- The `-auth` stacks are termination-protected. The guardrails and the boundary deny `DeleteStack` and `UpdateTerminationProtection` on them, as for `CDKToolkit`. A deploy that changes the stack can still damage it, so full central ownership waits for the dedicated account (M5).

### Cost safety

- The existing monthly budget, alerts, anomaly detection and kill switch stay.
- **Per-stage tags**, so CI spend is visible separately.
- CI deploys only on main, with an optional manual approval. PRs never touch AWS.
- Smoke test: one or two questions with a small `maxTokens`.
- **Pricing (from the review, to verify for London in M0.5):** Managed KB is about $5/GB of raw data per month plus $1 per 1,000 Retrieve calls, with no hourly minimum. Gateway, Runtime and token charges come on top. The loader enforces a maximum `knowledge/` size (for example 10 MB).

### Content and prompt-injection safety

- **Retrieved content is untrusted at runtime**, even though `knowledge/` comes from the repo. A bad edit or a malicious PR could plant instructions.
  - `knowledge/` changes go through PR review (CODEOWNERS covers `agents/**/knowledge/`).
  - The system prompt tells the agent that retrieved text is reference data, not instructions.
  - Iteration and token caps limit the damage from runaway loops.
  - The adversarial smoke test (§5) checks this.
- **Harness features considered and left off:**
  - Bedrock Guardrails: callers can override them.
  - Gateway Cedar policies: there's one read-only tool, so nothing to gate.
  - Skills, custom containers, environment variables, mounted filesystems and memory: each one widens what an agent can do.
  - Export: it leaves out gateway tools.
  - An `afterInvocation` hook for usage events: deferred until reports need more than Cost Explorer and the stream's usage events.
- By default no tools beyond Retrieve, so injected text can't trigger side effects. A token holder can enable more tools (D15), which is one more reason tokens are for trusted maintainers only. The remaining risks are disclosing KB content (which is public demo content anyway), going off-task, and wasting tokens.
- Never put secrets in `knowledge/`; gitleaks scans it too.

### Working with AI assistants

- Claude Code runs as the developer identity only.
- **No AWS credentials are given to Codex or other reviewers.** They review files read-only.

## 9. Open questions

1. ~~Name?~~ **Decided:** `agentharness` (D12).
2. ~~GitHub owner?~~ **Decided:** a personal account, `github.com/sattaman/agentharness` (public, Apache-2.0, `main` protected).
3. ~~Teardown after every run or weekly?~~ **Proposed:** after every run, revisited with measured costs.
4. ~~Manual approval or auto-deploy?~~ **Proposed:** manual approval first.
5. Dedicated AWS account: **proposed** to create it before M5 (CI trust). Local development can stay in the current account until then, or move earlier if you prefer.

## 10. Changes after the Codex review (v1 → v2)

**Accepted:**

- A dedicated account and a scoped execution policy are now a prerequisite for CI trust (previously "when convenient").
- The budget action is now described as an access stop, not a spend cap. Added a teardown runbook and quotas.
- The OIDC environment branch restriction is spelled out and must be tested.
- The cost estimate moved to M0.5, before the first deploy.
- PR checks and a minimal README moved into M0.
- CI deploys are now manually approved, with destroy after each run.
- Testing: a fresh session, a tool-event assertion, an adversarial document, lifecycle tests, IAM simulation. Snapshots dropped.
- Retrieved content is treated as untrusted. CODEOWNERS covers `knowledge/`.
- npm: trusted publishing implies provenance; reserve the scope; check `npm pack` output.
- Commands use `pnpm --dir`. The 15-minute claim excludes account setup.

**Not accepted / adjusted:**

- _A random golden fact per run._ That would mean uploading a new document and waiting for re-ingestion on every run. A fixed fact that appears only in `knowledge/`, together with the tool-event assertion, gives the same guarantee more cheaply.
- _Hide the Q&A from the public job summary._ We kept a short answer because the demo content is public by design; the summary is still the visible proof that it works.

## 11. Spend controls

**Built (D18):** the front door meters every call and enforces a monthly budget per caller. It reserves each call's maximum cost before invoking and settles the actual cost afterwards, in a DynamoDB ledger. AWS Budgets is the slow backstop: a Budget Action applies a deny policy to the front-door role at 100% of the account budget.

| Need                      | Mechanism                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Limit per call**        | Harness token, iteration and time limits, made binding by the front door (D17)                                                                               |
| **Limit per caller**      | Monthly USD budget in `callers.json` (default $5); 429 once reached (D18)                                                                                    |
| **Limit for the account** | Budget Action: `agentharness-spend-stop` on the front-door role (setup.md step 16)                                                                           |
| **Observe**               | One content-free log line per request: caller, agent, tokens, cost, reservation                                                                              |
| **Reconcile**             | Cost Explorer by `project`, `stage` and `agent` tags. Bedrock spend by IAM principal (execution role) once activated and checked against a real billing line |

**Next:**

- Logs Insights queries in the runbook.
- CloudWatch metrics from the log line.
- `agentharness costs` (metered compared with billed).
- Per-agent budgets if needed.

**Not doing:** per-agent AWS Budgets with Budget Actions (no IAM principal tag filter, hours of lag), application inference profiles (attribution only), API Gateway usage plans (API keys, best effort).

## 12. Central approval of agent spaces (deferred; design recorded)

**Goal:** teams can't create agents, or the resources behind them, without central approval. A **space** is a team's approved area: owners, a budget, and a list of agents.

**Status:** not built. One maintainer and one account don't need it. This section records how it would work and what IAM can and can't enforce.

### Shape

- **Registry as code, approval as a PR.** `spaces/<space>/space.json` (`owners`, `monthlyBudgetUsd`, `agents`). CODEOWNERS makes the platform team the required reviewers. The merge is the approval, and git history is the audit trail.
- **The platform owns everything long-lived** for each space: the Cognito client, and the execution roles.
- **The team experience is unchanged:** `agents/<name>/` plus a deploy.

### What IAM can and can't enforce (Service Authorization Reference, 2026-11-15)

- **`CreateHarness` can't be restricted by name.** It has no resource-level permissions. It does support `aws:RequestTag` and `aws:TagKeys`, so _required tag values_ (`space`, `agent`) can be enforced, as long as nobody can change the tags afterwards.
- **Update, delete and invoke can be scoped** by name prefix (a Harness ID is `<name>-<10 characters>`) or by tag.
- **`iam:PassRole` limited to a space's own execution roles** stops a team borrowing another team's permissions. It does **not** cap the agent count: several Harnesses can reuse one role. `CreateHarness` also needs `CreateAgentRuntime`, `CreateMemory`, `GetMemory` and `TagResource`. Which resources those can be scoped to is untested.
- **A CDK bootstrap qualifier only namespaces resources.** Isolation comes from a scoped CloudFormation execution role per space, and from controlling who can operate which stacks. Anyone who can update or delete a stack acts as its role.

### Consequences

- **Central CI deploys.** If the registry must be enforced exactly, the platform's CI must be the only thing that can create Harnesses. Teams open PRs, and the platform deploys from their repos. That is simpler to reason about than per-space deploy roles.
- **Naming needs a redesign first.** Harness names are capped at 40 characters, and today's longest is 38, so there's no room for a space segment. A space tag doesn't prevent collisions either: two spaces with the same stage and agent get identical stack and Harness names. So stages must be unique across the account, or names need redesigning.
- **Approve each agent,** to keep per-agent attribution. **One Cognito client per space,** so each space's access can be revoked separately.
- **The path to scale is an account per space** under AWS Organizations: hard isolation, separate billing, and service control policies.

## 13. Changes after checking the Harness security docs (2026-11-15)

- **Harness settings are defaults, not limits.** A token holder can override the model, prompt, tools, `allowedTools`, skills and limits, including turning on shell and web tools. Tokens are now described as trusted-maintainer credentials, and a validating layer is required before any untrusted caller (§8, D15).
- **The execution role is the enforced boundary.** Model calls must now go through the configured inference profile (`bedrock:InferenceProfileArn`), and `sts:AssumeRole` is denied.
- **The `-auth` stacks are protected** in the guardrails and boundary, like `CDKToolkit`.
- **§11 is smaller:** observe, report, stop. Per-agent Budget Actions are deferred, because Budgets document no IAM principal tag filter and their enforcement lags. Application inference profiles are the recorded upgrade path.
- **§12 is deferred,** with its IAM claims corrected: `CreateHarness` can't be restricted by name, `PassRole` doesn't cap the agent count, and qualifiers don't isolate.
- **New tests:** an override probe, plus IAM simulation of model and gateway isolation (§5).
- **Also from the docs:**
  - A token can open a root shell, and `additionalParams` can leak the role's credentials (D15). The untrusted-caller design now uses SigV4 with no shell permissions.
  - Each Harness now sets the invocation `maxTokens` budget, a sliding-window `truncation`, and shorter session lifetimes (D8).
- **A front door is now part of the MVP (D17).** It makes access safe to share with other teams. Verified live: no token gives 401, overrides give 400, an agent not granted gives 403, and a token sent straight to a Harness gives 403.
- **Spend is metered and capped in the front door (D18).** §11 is rewritten: per-caller monthly budgets with reserve-and-settle in DynamoDB, and a Budget Action on the front-door role as the backstop. D5's prices are corrected to London rates.
