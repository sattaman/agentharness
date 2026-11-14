# Plan: MVP, CI, deployment and safety

Status: **agreed**, 2026-11-14. **M1 done** (deployed and verified 2026-11-14), plus bearer-token auth (D15) and nightly cleanup (D16). Revised after an external review (Codex); the changes are listed in §10. Naming, structure and git conventions are recorded in [decisions.md](decisions.md) D12–D14.

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
pnpm --dir examples/helper chat helper         # terminal chat, streams the answer + token usage
pnpm --dir examples/helper destroy             # clean teardown (including the KB and S3)
```

Each script calls the `agentharness` CLI or `cdk`. The 15-minute target starts _after_ the one-off account setup and `cdk bootstrap`, which `docs/setup.md` documents separately.

After the MVP, users install `agentharness` from npm into their own repo, laid out like `examples/helper`.

### Milestones

Each milestone ends with something that runs.

| #    | Milestone                                                                                                                                                          | Done when                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0   | **Repo hygiene and offline CI**: rename, scrub the docs, `git init`, gitleaks, lint/format, Vitest, monorepo layout, **`pr.yml`**, a minimal README                | First commit passes the leak scan; PR checks are green and required on `main`; nothing account-specific is tracked                                            |
| M0.5 | **Cost estimate**: a London-region estimate for Harness/Runtime, Gateway, Managed KB (storage + retrieval), tokens and logs; set the KB size cap and the CI budget | The numbers are in `docs/cost.md`; §9 Q3 is answered with data                                                                                                |
| M1   | **Walking skeleton**: a hand-written stack with one `CfnHarness` (no KB) and a chat script                                                                         | Deployed to a personal stage; we get a streamed answer; destroy works and leaves nothing behind. _This de-risks the newest, least-documented resource first._ |
| M2   | **Loader**: folder → `AgentSpec` (zod), with fixtures for valid and invalid cases                                                                                  | Unit tests cover every rule. M1's hard-coded values now come from `agent.json` / `prompt.md`                                                                  |
| M3   | **Knowledge base**: S3 upload, Managed KB, ingestion custom resource, Gateway KB connector, Harness tool wiring                                                    | The chat answers a question whose answer exists only in `knowledge/`; the stream shows a `Retrieve` tool event. Measured cost matches M0.5                    |
| M4   | **Construct API and synth tests**: the `Agents` construct and `agentharness synth` discovering `agents/*/`; template assertions; cdk-nag clean                     | The example contains no code; README walkthrough works from a clean clone                                                                                     |
| M5   | **Dedicated AWS account + CI OIDC role** (see §8)                                                                                                                  | The role can deploy only in the new account; a run from a non-`main` branch is shown to fail to get credentials                                               |
| M6   | **CI: deploy and smoke test**, manually approved                                                                                                                   | Approving a run deploys `stage=ci`, the smoke test passes, the job summary shows the result and token count, and the stage is torn down                       |
| M7   | **Docs and release**: demo GIF, architecture diagram, security and cost sections; publish `agentharness@0.1.0` via npm trusted publishing                          | `npm pack` contents are reviewed; a stranger can follow the README                                                                                            |

**Out of the MVP** (phase 2): web UI (AG-UI), the cost-reporter agent, a `create-agentharness` starter, evals, multiple regions, memory.

## 4. Repo layout

See D12. Each concept gets one file in `packages/agentharness/src/` (for example `load.ts`, `schema.ts`, `agents.ts`, `knowledge.ts`, `chat.ts`, `cli.ts`), and only `index.ts` and `cli.ts` are public.

- `aws-cdk-lib` and `constructs` are **peerDependencies** of `agentharness`.
- Every stack takes a `stage` (default `dev`, validated as `[a-z0-9]{1,12}`). Stack names include it, so personal and CI stacks never collide.

## 5. Testing strategy

| Layer                                                                                                                                                                                                                    | Tooling                  | AWS?      | Runs                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------- | ----------------------------------------------- |
| Unit: loader rules, name validation, YAML errors                                                                                                                                                                         | Vitest + fixture folders | No        | Pre-commit (changed files), every PR            |
| Synth: resource shape, IAM (no `*` actions or resources except where AWS requires them, and each one documented), "no `knowledge/` → no KB", `allowedTools` pinned, memory disabled, tags present, cdk-nag zero findings | `aws-cdk-lib/assertions` | No        | Every PR                                        |
| IAM simulation: `iam simulate-principal-policy` for the CI role and the runtime roles (allowed and denied cases)                                                                                                         | AWS CLI                  | Read-only | When roles change; in M5                        |
| Smoke: deploy, wait for ingestion, ask a golden question in a **fresh session**, check that the answer contains the planted fact **and** that a `Retrieve` tool event appeared, then report tokens                       | Vitest + SDK             | **Yes**   | Manually approved CI run; by hand from a laptop |
| Adversarial smoke: a planted "ignore your instructions" document; the agent must still answer the task and not echo the injected text                                                                                    | Vitest + SDK             | Yes       | With the smoke test                             |
| Lifecycle: edit or delete a knowledge file, redeploy and confirm re-ingestion; empty `knowledge/`; failed ingestion surfaces as a deploy error; `destroy` leaves no stack, bucket or KB                                  | Script                   | Yes       | Before M7, then by hand                         |
| Evals (phase 2): `agents/<name>/evals.json` + LLM judge                                                                                                                                                                  | —                        | Yes       | Nightly / by hand                               |

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

1. **Personal stage** (`stage=dev`) in your account, through `pnpm chat`. This is the development loop.
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
- **The budget action is an access stop, not a spend cap.** Denying the developer and CI identities stops _new_ deploys and calls by them. It doesn't stop resources that are already running, and budget alerts lag actual usage. To actually limit spend:
  - Service quotas and kit-enforced limits (tokens, iterations, KB size).
  - Destroy-after-run in CI.
  - A tested **emergency teardown runbook** (`docs/runbook.md`): destroy all `agentharness-*` stacks, then check with the Resource Groups tag API that no tagged resources remain.

### What the stacks create (enforced by synth tests)

- Least-privilege roles, all carrying the boundary.
- Harness:
  - Model and system prompt pinned.
  - `allowedTools` explicit (gateway Retrieve only).
  - Memory disabled.
  - Caller overrides never forwarded.
  - `maxIterations`, `maxTokens` and `timeoutSeconds` set from `agent.json`, with **kit-enforced upper limits**.
- S3:
  - Block public access.
  - Enforce SSL.
  - SSE (S3-managed keys for the MVP; KMS optional).
  - `RemovalPolicy.DESTROY` + `autoDeleteObjects` only for non-prod stages.
- Logs: retention set (for example 30 days), so nothing is kept forever.
- No public endpoints. Inbound auth is SigV4 only.

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
- No tools beyond Retrieve in the MVP, so injection can't trigger side effects. The remaining risks are disclosing KB content (which is public demo content anyway), going off-task, and wasting tokens.
- Never put secrets in `knowledge/`; gitleaks scans it too.

### Working with AI assistants

- Claude Code runs as the developer identity only.
- **No AWS credentials are given to Codex or other reviewers.** They review files read-only.

## 9. Open questions

1. ~~Name?~~ **Decided:** `agentharness` (D12).
2. GitHub owner: a personal account (recommended for a portfolio) or a new org?
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
