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
13. Activate the `project` cost allocation tag in Billing as soon as the first resource exists. It takes up to about 48 hours.

## Each shell

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=<region>
export AGENTHARNESS_PERMISSIONS_BOUNDARY=agentharness-boundary
```
