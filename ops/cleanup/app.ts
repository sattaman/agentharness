import { App, Stack, Tags, TimeZone, Validations } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Schedule, ScheduleExpression, ScheduleTargetInput } from 'aws-cdk-lib/aws-scheduler';
import { Universal } from 'aws-cdk-lib/aws-scheduler-targets';
import { AwsSolutionsChecks } from 'cdk-nag';

const stages = ['dev'];

const app = new App();
Tags.of(app).add('project', 'agentharness');
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

const stack = new Stack(app, 'agentharness-cleanup', {
  description: 'Deletes agentharness stage stacks every night so nothing is left running.',
});

for (const stage of stages) {
  const stackName = `agentharness-${stage}-agents`;
  new Schedule(stack, `Delete-${stage}`, {
    description: `Deletes ${stackName} every night`,
    schedule: ScheduleExpression.cron({ hour: '2', minute: '0', timeZone: TimeZone.EUROPE_LONDON }),
    target: new Universal({
      service: 'cloudformation',
      action: 'deleteStack',
      input: ScheduleTargetInput.fromObject({ StackName: stackName }),
      policyStatements: [
        new PolicyStatement({
          actions: ['cloudformation:DeleteStack'],
          resources: [
            stack.formatArn({
              service: 'cloudformation',
              resource: 'stack',
              resourceName: `${stackName}/*`,
            }),
          ],
        }),
      ],
      retryAttempts: 3,
    }),
  });
  Validations.of(stack).acknowledge({
    id: `AwsSolutions::AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:<AWS::Region>:<AWS::AccountId>:stack/${stackName}/*]`,
    reason: 'Stack ARNs end in a generated ID, so the name is the narrowest match.',
  });
}
