import {
  CfnGateway,
  CfnGatewayTarget,
  type CfnGatewayTargetProps,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { fromThisAccount, serviceRole, type Permission } from './iam.js';

/** One capability behind an agent's Gateway: its knowledge base, or a built-in tool. */
export interface GatewayTool {
  /** The target name. The agent sees the target's tools as `<name>___<tool>`. */
  readonly name: string;
  readonly targetConfiguration: CfnGatewayTargetProps['targetConfiguration'];
  /** What the Gateway's role needs to reach this target, and nothing more. */
  readonly permissions: readonly Permission[];
}

export interface GatewayProps {
  readonly name: string;
  readonly tools: readonly GatewayTool[];
}

/**
 * An agent's own Gateway. Agents never share one: with IAM auth, a role that can invoke
 * a Gateway reaches every target behind it (D6).
 */
export class Gateway extends Construct {
  readonly resource: CfnGateway;

  constructor(scope: Construct, id: string, { name, tools }: GatewayProps) {
    super(scope, id);

    const role = serviceRole(
      this,
      'Role',
      fromThisAccount('bedrock-agentcore.amazonaws.com'),
      tools.flatMap(({ permissions }) => permissions),
    );

    this.resource = new CfnGateway(this, 'Resource', {
      name,
      roleArn: role.roleArn,
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
    });

    for (const tool of tools) {
      new CfnGatewayTarget(this, `Target-${tool.name}`, {
        name: tool.name,
        gatewayIdentifier: this.resource.attrGatewayIdentifier,
        targetConfiguration: tool.targetConfiguration,
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      });
    }
  }
}
