# Setup

One-off steps before the first `cdk deploy`. Steps marked 👤 are done by a person in the AWS console.

## Account (👤)

1. **Root user:** enable MFA, delete any root access keys, and check the billing and security contacts.
2. **Billing access:** as root, turn on Account → _IAM user and role access to billing information_.
3. **Admin user:** create an IAM user with MFA and `AdministratorAccess`. Don't create access keys. Use it instead of root from now on.
4. **Budget:** create a monthly cost budget with email alerts at 50%, 80% and 100% of actual spend, plus a forecast alert. Optionally add a budget action that attaches a deny-all policy to the developer identity.
5. **Cost Explorer:** open it once to turn it on. Data appears after about 24 hours.
6. **Developer identity (optional):** a second IAM user for day-to-day work and AI tooling, with `PowerUserAccess` + `IAMReadOnlyAccess` and the policy in [iam/developer-guardrails.json](iam/developer-guardrails.json). Replace the `OTHER-WORKLOAD-*` placeholders, or delete that statement if the account isn't shared.

## Local machine

7. **AWS CLI** ≥ 2.35.7 (`aws --version`).
8. **Sign in:** `aws login --profile <profile>` and set your region. Check with `aws sts get-caller-identity --profile <profile>`.
9. **No long-lived keys:** if `~/.aws/credentials` has `AKIA…` keys, deactivate and delete them in IAM, then remove them from the file.
10. **Node 24** (`.nvmrc`) and pnpm via corepack (`corepack enable`).

## Bootstrap (as admin)

11. Create the permissions boundary from [iam/boundary.json](iam/boundary.json), named `agentharness-boundary` (or your own name; update the ARN inside the policy to match).
12. From a folder with no `cdk.json`:
    ```bash
    pnpm dlx aws-cdk bootstrap --custom-permissions-boundary agentharness-boundary --termination-protection
    ```
13. **Log retention** (one-off, account-wide but limited to agentharness runtime logs):
    ```bash
    aws logs put-account-policy --policy-name agentharness-runtime-logs --policy-type RETENTION_POLICY \
      --policy-document '{"retentionInDays": 30, "enforcementMode": "RETROACTIVE"}' \
      --selection-criteria 'LogGroupNamePrefix="/aws/bedrock-agentcore/runtimes/harness_agentharness_"'
    ```
    Add `--dry-run` first to see which log groups it would affect. It takes effect within 24 hours.
14. **Tracing:** enable CloudWatch Transaction Search once per account (CloudWatch → Application Signals → Transaction Search). Harness traces don't appear without it.
15. Activate the `project` cost allocation tag in Billing as soon as the first resource exists. It takes up to about 48 hours.

## Permissions boundary for app roles

Bootstrap's `--custom-permissions-boundary` only bounds CDK's own execution role. Roles that the stacks create need the boundary too, through CDK's standard context key. Put it in `~/.cdk.json`, outside the repo:

```json
{
  "context": {
    "@aws-cdk/core:permissionsBoundary": { "name": "agentharness-boundary" }
  }
}
```

This applies to every CDK app on the machine, which is what you want when the account requires the boundary. To scope it to one app instead, put the same `"@aws-cdk/core:permissionsBoundary"` entry in that app's `cdk.context.json` (gitignored). Skip both if your account has no boundary.

Don't use `cdk … -c '@aws-cdk/core:permissionsBoundary={"name":"…"}'`: `-c` passes a string, and CDK silently ignores it, so roles are created without the boundary.

## Each shell

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=<region>
```
