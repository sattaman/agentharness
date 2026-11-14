# Research notes — 2026-11-13

These findings come from parallel research against official docs, npm and AWS announcements.

- **Status labels:** GA / preview / unverified. Anything marked unverified needs checking during the build.
- **Versions** were checked against npm on 2026-11-13.

## Versions
| Package / tool | Version | Note |
|---|---|---|
| aws-cdk-lib | 2.277.0 | Stable AgentCore L2s since 2.255 (May 2026); Harness is L1 only |
| aws-cdk (CLI) | 2.1148.1 | Needs ≥ 2.1034.0 to use `aws login` credentials |
| cdk-nag | 3.0.2 | Major bump from 2.x |
| @aws-sdk/client-bedrock-agentcore | 3.1169.0 | `InvokeHarnessCommand` |
| @aws-sdk/client-cost-explorer | 3.1169.0 | Phase 2 |
| @aws/agentcore (CLI) | 1.0.3 | GA. `add harness` defaults to Claude Sonnet, so pass `--model`. Can be shadowed by the old Python `agentcore` |
| @aws/agentcore-cdk | 1.0.3 | L3s (`AgentCoreHarness`, `AgentCoreGateway.addKnowledgeBaseTarget`, `AgentCoreKnowledgeBase`); not used (D7) |
| @aws-cdk/aws-bedrock-agentcore-alpha | 2.277.0-alpha.0 | Only Policy is still alpha |
| @strands-agents/sdk | 1.25.0 | GA. Repo moved to `strands-agents/harness-sdk` (`strands-ts/`) |
| @ag-ui/core, client, encoder | 1.0.4 | AG-UI 1.0 GA |
| @ag-ui/aws-strands | 1.0.2 | Express adapter for Strands TS |
| @copilotkit/react-core | 1.87.1 | v2 API at `@copilotkit/react-core/v2` |
| @anthropic-ai/sdk, @anthropic-ai/bedrock-sdk | 1.8.0, 1.1.2 | `AnthropicBedrockMantle` |
| AWS CLI v2 | latest 2.40.x | Minimums: `s3vectors` 2.27.51, `bedrock-agentcore` 2.27.53, harness 2.34.35, harness GA changes 2.35.7, `aws login` 2.32.0 |
| Node.js | 24 (target) | Node 26 is LTS since 2026-10-28, but Lambda `nodejs26.x` is still preview. Lambda Node 22 is deprecated 2027-05-30 |

## AgentCore Harness (GA 2026-06-17)

**Pricing**
- There is no Harness charge.
- You pay for:
  - Runtime microVM time: per-second CPU plus peak memory. Memory bills while idle, up to the idle timeout (default 900s).
  - Tokens, Memory, Gateway calls and CloudWatch.
- CloudTrail logs it as `InvokeAgentRuntime`.

**`CfnHarnessProps`**
- **Required:**
  - `harnessName`: `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`. No hyphens; changing it replaces the resource.
  - `executionRoleArn`
  - `model`
- **Optional:**
  - `systemPrompt: [{text}]`
  - `tools`, `allowedTools`, `skills`
  - `memory`: managed and on by default; set `memory.disabled` to turn it off.
  - `maxIterations` (default 75), `maxTokens`, `timeoutSeconds` (default 3600)
  - `truncation`, `hooks` (BeforeInvocation, AfterInvocation, BeforeToolCall, AfterToolCall; max 20)
  - `authorizerConfiguration.customJwtAuthorizer`
  - `environment`, `environmentArtifact`, `environmentVariables`
  - `tags`
- **Model:** `model.bedrockModelConfig` takes `{modelId, apiFormat: converse_stream | responses | chat_completions, maxTokens, temperature, topP, additionalParams}`. Other providers: Gemini, LiteLLM, OpenAI.
- **Tool types:** `remote_mcp`, `agentcore_gateway`, `inline_function` (runs client-side and pauses the loop, so it's a bad fit for RAG), `agentcore_browser`, `agentcore_code_interpreter`. Gateway `outboundAuth` is `awsIam`, `oauth` or `none`.
- **GetAtt:** `Arn`, `HarnessId`, `Status`, `Version`, and the underlying Runtime ARN. Also `CfnHarnessEndpoint`.

**Invoking**
- Call `InvokeHarnessCommand` with `{harnessArn, runtimeSessionId (≥33 chars; reuse it to continue a conversation), messages}`.
- Optional fields: `qualifier`, `runtimeUserId`, `actorId`, and per-call overrides. **Never forward user-supplied overrides.**
- Stream events: `messageStart`, `contentBlockStart`, `contentBlockDelta` (text / toolUse / reasoningContent), `contentBlockStop`, `messageStop`, `metadata` (token usage, cache tokens), `hookEvent`, `runtimeClientError`.
- Inbound auth: SigV4 by default, or JWT (HTTPS POST to `/harnesses/invoke` with a Bearer token). Per-user downstream identity needs JWT.

**Gotchas**
- Omitting `allowedTools` (or using `["*"]`) gives the agent shell and file tools, plus about 3k tokens of tool definitions per call. Use explicit selectors. The selector syntax (e.g. `@kb/*`) is unverified.
- Omitting `model`, `systemPrompt` or `truncation` gives managed defaults that can change. The default model is Claude Opus 5.
- Transaction Search must be enabled once per account for GenAI Observability. The agentcore CLI does this.
- VPC mode needs ECR, S3 and bedrock-runtime endpoints.
- Tags propagate to the Runtime and Memory.

## IAM
- **Harness execution role**
  - Trust: `bedrock-agentcore.amazonaws.com`.
  - Model: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the inference-profile ARN **and** on the foundation-model ARNs in every destination region.
  - Image pull: `ecr-public:GetAuthorizationToken`, `sts:GetServiceBearerToken`.
  - Tracing and logs: X-Ray puts; logs on `/aws/bedrock-agentcore/runtimes/*`; `cloudwatch:PutMetricData` (condition: namespace `bedrock-agentcore`).
  - Identity: `GetWorkloadAccessToken*` on the default workload-identity directory and `harness_<name>-*`.
  - Memory, if enabled: Create/Get/List/DeleteEvent and RetrieveMemoryRecords on `memory/harness_*`.
  - Gateway: `bedrock-agentcore:InvokeGateway` on the gateway ARN.
- **Gateway service role:** `bedrock:Retrieve` and `bedrock:GetKnowledgeBase` on the KB. Add `bedrock:AgenticRetrieveStream` if that tool is enabled.
- **Caller (you or the chat script):** `bedrock-agentcore:InvokeHarness` **and** `bedrock-agentcore:InvokeAgentRuntime` on the harness ARN, plus the endpoint ARN if you use a qualifier.
- **Phase 2 cost tool:** `ce:GetCostAndUsage` and `ce:GetCostForecast`. Cost Explorer has no resource-level permissions, so hard-code the tag filter in the tool.

## Knowledge base
- **Managed KB (GA 2026-06-17):** `AWS::Bedrock::KnowledgeBase` with `type: MANAGED` and an S3 data source of type `MANAGED_KNOWLEDGE_BASE_CONNECTOR`. Deploying does **not** ingest, so call `StartIngestionJob`.
- **Gateway connector:** `connectorId: bedrock-knowledge-bases`. It offers two tools:
  - `Retrieve` (hybrid search)
  - `AgenticRetrieveStream` (multi-step retrieval with a cited answer)
  - It works only with Managed KBs and `GATEWAY_IAM_ROLE` outbound auth. Docs: devguide `gateway-target-connector-managed-kb`, Bedrock userguide `kb-gateway-target`.
- **Managed KB pricing: unverified.** Check it before the first deploy.
- **Fallback (classic KB):**
  - **Vector store:** S3 Vectors (GA Dec 2025). Storage is about $0.06 per GB-month and queries about $2.5 per million; there's no idle minimum, unlike OpenSearch Serverless.
  - **CDK:** L1 only (`aws_s3vectors`, `CfnKnowledgeBase.s3VectorsConfiguration`).
  - **Embeddings:** Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`, 1024 dimensions, about $0.02 per million tokens).
  - **Agent access:** needs a Lambda Gateway target.

## Models
- **Nova 2 Lite** (GA 2025-12-02; EOL no sooner than 2026-12-02, so watch for its successor)
  - Base ID `amazon.nova-2-lite-v1:0`. It has no in-region access, so call it through a profile: `global.`, `us.`, `eu.` or `jp.`.
  - 1M input / 64K output. Reasoning is off by default (`reasoningConfig` low / medium / high). Prompt caching up to 20K tokens.
  - About $0.30 / $2.50 per million tokens on the global profile; geo profiles are about 10% more. Aggregator figures, unverified.
  - Its model card says "Knowledge base: not supported". That refers to RetrieveAndGenerate and doesn't affect tool-based Retrieve.
- **Nova Micro:** `us.amazon.nova-micro-v1:0`, 128K context, about $0.035 / $0.14 per million tokens. Weaker at tool use.
- **Nova Premier and Nova 2 Pro** don't appear on the current model-cards page. Nova 2 Pro preview status is unclear.
- **Model access (2026):** the Model access page applies only to GovCloud now. Models are enabled on first invocation.
  - Third-party models need `aws-marketplace:Subscribe` and related permissions on the first call.
  - Amazon models need nothing.
- **Claude Haiku 5.5 on Bedrock**
  - Mantle endpoint: `anthropic.claude-haiku-5-5`, `bedrock-mantle:CreateInference`, `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`.
  - Access is gated, and Converse support is unverified.
  - Bedrock price: unverified. First-party is $0.10 / $0.50 per million tokens.

## Accounts, credentials, billing
- **Credentials:** use `aws login` (CLI ≥ 2.32.0). It reuses your console sign-in with short-lived, auto-refreshed credentials. A non-root identity needs the `SignInLocalDevelopmentAccess` policy. Identity Center is only worth it for multiple accounts.
- **`cdk bootstrap`:** creates the `CDKToolkit` stack: an assets bucket, an ECR repo, an SSM parameter and 5 roles (template v32). The CloudFormation execution role gets AdministratorAccess unless you pass `--cloudformation-execution-policies`. After bootstrap, deployers mostly need `sts:AssumeRole` on the `cdk-hnb659fds-*` roles.
- **Cost Explorer:** enabled the first time you open it. Data takes about 24h. The API costs $0.01 per request, including each paginated call. DAILY and MONTHLY data cover 14 months; HOURLY is opt-in, from the payer account.
- **Cost allocation tags:**
  - Only the management or standalone account can activate them.
  - Up to 24h until the tag key appears, plus up to 24h to activate. Not retroactive.
  - There's no CloudFormation resource, so use an `AwsCustomResource` calling `ce:UpdateCostAllocationTagsStatus`, or the CLI.
- **Bedrock cost attribution:** tag the IAM principal (GA April 2026), or use application inference profiles. CloudWatch `AWS/Bedrock` reports InputTokenCount and OutputTokenCount by ModelId.
- **Budgets:** free for monitoring. Cost Anomaly Detection: free, and supported in CDK (`CfnAnomalyMonitor` / `CfnAnomalySubscription`).
- **Free Tier (since 2025-07-15):**
  - Up to $200 in credits.
  - The Free plan lasts up to 6 months, after which the account is suspended unless you upgrade.
  - Whether Harness and Managed KB are allowed on the Free plan is unverified.

## eu-west-2 (London), checked 2026-11-14
- **Available in London:**
  - AgentCore: Harness, Gateway, Runtime, Observability, Memory, Identity, Policy, Evaluations.
  - Managed KB, plus the Gateway managed-KB target.
  - Classic KB with Titan V2 / Cohere embeddings.
  - S3 Vectors (`s3vectors.eu-west-2.api.aws`).
- **Not available in London:** the AgentCore Web Search tool.
- **Unverified:** whether Transaction Search covers London. Check in the console.
- **Nova 2 Lite:** no in-region access. London isn't a source region for the `eu.` profile (which routes to FRA, ARN, MXP, ZAZ, DUB, CDG). Only `global.` works.
- **Nova Micro:** in-region in London, with no geo or global profile.
- **AgentCore pricing:** one global rate set, with no regional breakdown.
- **Cost Explorer API:** single endpoint `ce.us-east-1.amazonaws.com`, so point the SDK client at us-east-1.

## DynamoDB free tier (always free, checked 2026-11-14)
- **Allowance:** 25 GB Standard storage, 25 WCU and 25 RCU **provisioned only**, 25 rWCU, and 2.5M Streams reads per month. It's per region, per payer account, and applies on the Free plan, the Paid plan and the legacy tier.
- **On-demand reads and writes are never free.** On-demand tables still get the free storage.
- **Common surprise charges:**
  - On-demand mode.
  - GSIs counting toward the 25 capacity units.
  - Standard-IA tables.
  - PITR and backups.
  - Replicas.
  - Contributor Insights.
  - Tables in several regions (the allowance is per region).
- **Usage types to look for in Cost Explorer:**
  - On-demand: `EUW2-ReadRequestUnits` / `WriteRequestUnits`.
  - Provisioned: `EUW2-Read/WriteCapacityUnit-Hrs`.
  - Backups and PITR: `-TimedPITRStorage-ByteHrs`, `-TimedBackupStorage-ByteHrs`.

## Phase 2 notes (AG-UI + cost agent)
- **AgentCore Runtime protocols:** HTTP, MCP, A2A and **AGUI** (GA 2026-03-13). AGUI listens on 8080 at `/invocations` (SSE), `/ws` and `/ping`, and needs an arm64 container.
- **Recommended stack if Runtime is used:**
  - Server: Strands TS + `@ag-ui/aws-strands` (Express).
  - Frontend: Vite + React + CopilotKit v2 (`selfManagedAgents` + `HttpAgent` carrying the JWT, `CopilotChat`, `useRenderTool`).
- **Report rendering:** use controlled generative UI. A tool returns typed JSON, and your own components render it. Use A2UI v0.9 only if the agent needs to design layouts.
- **Auth:** Cognito with a `CUSTOM_JWT` authorizer. Allowlist the `Authorization` header. Keep the session ID header stable per conversation, and retry 409 `SESSION_BUSY`.
- **CORS:** unclear whether the managed endpoint handles preflight requests. Put CloudFront in front of both the static site and the runtime, with caching and compression disabled on the SSE path.
- **Cost tool:**
  - Call Cost Explorer directly from a custom tool and hard-code the `project` tag filter.
  - Cache results, since the data changes about once a day.
  - Combine with live token metrics, because cost data lags about 24h.
- **MCP servers:**
  - `awslabs.cost-explorer-mcp-server` is deprecated and was removed from PyPI.
  - `awslabs.billing-cost-management-mcp-server` 0.0.45 is Python.
  - The managed AWS MCP Server (GA 2026-05-06) is broad by design.

## Key sources
- Harness CFN: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-harness.html
- Harness GA: https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-harness-generally-available
- Harness security/IAM: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.md
- Harness models: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html
- Gateway Managed KB connector: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-managed-kb.md
- AgentCore regions: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html
- AgentCore pricing: https://aws.amazon.com/bedrock/agentcore/pricing/
- CDK AgentCore: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html
- Nova 2 Lite card: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html
- Model access: https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html
- `aws login`: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html
- CDK bootstrapping: https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html
- Cost allocation tags: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/custom-tags.html
- Billing access for IAM: https://docs.aws.amazon.com/cost-management/latest/userguide/control-access-billing.html
- Free Tier FAQ: https://aws.amazon.com/free/free-tier-faqs/
- AG-UI on AgentCore: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html
- AWS CLI changelog: https://github.com/aws/aws-cli/blob/v2/CHANGELOG.rst
