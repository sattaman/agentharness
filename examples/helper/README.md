# My agents

Agents deployed to Amazon Bedrock AgentCore with [agentharness](https://github.com/sattaman/agentharness). Each folder in `agents/` is one agent:

```
agents/
└── helper/
    ├── agent.json     # model, limits, and who may call it
    ├── prompt.md      # system prompt
    └── knowledge/     # documents the agent can search
callers.json           # monthly budget per caller (optional)
```

## Before you start

- **Node 24**, and the **AWS CLI 2.35.7 or later**, signed in to your account (`aws login`, or `aws sso login`) with permission to deploy. An administrator role is simplest for a first try.
- **A Region with AgentCore Harness**, Managed Knowledge Bases and Amazon Nova 2 Lite. agentharness is tested in `eu-west-2` (London). Nova 2 Lite runs through a global inference profile, so requests may be processed outside your Region.

## Deploy

```bash
npm install
npx cdk bootstrap      # once per AWS account and Region
npm run deploy         # creates two stacks, then loads knowledge/ into the knowledge base
```

This deploys the `dev` stage:

- **`agentharness-dev-auth`**: who can call your agents, the API in front of them, and a spend ledger. Long-lived.
- **`agentharness-dev-agents`**: the agents and their knowledge. Safe to destroy and redeploy at any time.

For another stage, add `-c stage=<name>` to the `cdk` commands and `--stage <name>` to `npm run sync`.

## Call your agent

Your agents are reachable only through the API, with a token. Every deployment has a `maintainers` caller that can call every agent. Get a one-hour token for it:

```bash
STACK=agentharness-dev-auth
out() { aws cloudformation describe-stacks --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLIENT_ID=$(out maintainersClientId)
SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$(out UserPoolId)" --client-id "$CLIENT_ID" \
  --query UserPoolClient.ClientSecret --output text)
TOKEN=$(aws cognito-idp get-client-token --client-id "$CLIENT_ID" --secret "$SECRET" \
  --query ClientAuthenticationResult.AccessToken --output text)
API_URL=$(out ApiUrl)
```

Then ask a question. The example's knowledge base knows about a fictional studio:

```bash
curl -N "${API_URL%/}/chat" -H "authorization: $TOKEN" -H 'content-type: application/json' \
  -d "{\"agent\":\"helper\",\"message\":\"What is the office plant called?\",\"sessionId\":\"$(uuidgen | tr A-Z a-z)\"}"
```

The answer streams back as one JSON object per line: `text` (the answer, in pieces), `tool` (the agent searched its knowledge), `usage` (tokens), and `stopped` or `error` if something went wrong. Send the same `sessionId` again to continue the conversation.

## Make it yours

- **Change the agent:** edit `agents/helper/prompt.md` and `agent.json`, then `npm run deploy`.
- **Change its knowledge:** edit the files in `knowledge/`, then `npm run sync`.
- **Add an agent:** add a folder under `agents/` (1–16 lowercase letters or digits), then `npm run deploy`.
- **Let another team call an agent:** add the team to `callers` in that agent's `agent.json`, and optionally set a monthly budget in `callers.json` (default $5). Deploy, then hand the team its client ID and secret from Cognito. The full guide is in the [agentharness README](https://github.com/sattaman/agentharness#give-a-team-access).

## Costs and clean-up

You pay per use: model tokens, AgentCore runtime while a conversation is active, knowledge-base storage and searches, and small amounts for API Gateway, Lambda, DynamoDB and logs. Nothing has an hourly minimum. Each caller's model spend is capped by its monthly budget.

```bash
npm run destroy        # removes the agents and their knowledge
```

The `-auth` stack is protected from deletion, because it holds credentials and spend records. To remove it too, turn off termination protection in the CloudFormation console, then delete it. The spend ledger table is kept after the stack is deleted; delete it from the DynamoDB console if you no longer need it.
