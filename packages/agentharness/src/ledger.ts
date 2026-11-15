import {
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type Update,
} from '@aws-sdk/client-dynamodb';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const dynamodb = new DynamoDBClient();
const maxAttempts = 5;

export async function reserve(
  table: string,
  key: string,
  micros: number,
  budgetMicros: number,
  ledgerId: string,
): Promise<boolean> {
  try {
    await transact(idempotencyToken(ledgerId, 'reserve'), {
      TableName: table,
      Key: { pk: { S: key } },
      UpdateExpression: 'ADD charged :amount',
      ConditionExpression: 'attribute_not_exists(charged) OR charged <= :limit',
      ExpressionAttributeValues: {
        ':amount': { N: String(micros) },
        ':limit': { N: String(budgetMicros - micros) },
      },
    });
    return true;
  } catch (error) {
    if (cancellationReasons(error).includes('ConditionalCheckFailed')) return false;
    throw error;
  }
}

export async function settle(
  table: string,
  key: string,
  deltaMicros: number,
  ledgerId: string,
): Promise<void> {
  if (deltaMicros === 0) return;
  await transact(idempotencyToken(ledgerId, 'settle'), {
    TableName: table,
    Key: { pk: { S: key } },
    UpdateExpression: 'ADD charged :delta',
    ExpressionAttributeValues: { ':delta': { N: String(deltaMicros) } },
  });
}

async function transact(token: string, update: Update): Promise<void> {
  const command = new TransactWriteItemsCommand({
    ClientRequestToken: token,
    TransactItems: [{ Update: update }],
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await dynamodb.send(command);
      return;
    } catch (error) {
      const conflict = cancellationReasons(error).includes('TransactionConflict');
      if (!conflict || attempt === maxAttempts) throw error;
      await setTimeout(Math.random() * 50 * 2 ** attempt);
    }
  }
}

const cancellationReasons = (error: unknown): string[] =>
  error instanceof TransactionCanceledException
    ? (error.CancellationReasons ?? []).map(({ Code }) => Code ?? '')
    : [];

const idempotencyToken = (ledgerId: string, step: string): string =>
  createHash('sha256').update(`${ledgerId}:${step}`).digest('hex').slice(0, 36);
