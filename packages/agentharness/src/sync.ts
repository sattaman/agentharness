import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  StartIngestionJobCommand,
  type IngestionJob,
} from '@aws-sdk/client-bedrock-agent';
import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { findKnowledge, type KnowledgeTarget } from './deployment.js';
import type { AgentSpec, KnowledgeFiles } from './load.js';

export interface Changes {
  readonly upload: readonly string[];
  readonly remove: readonly string[];
}

export function diff(
  local: ReadonlyMap<string, string>,
  remote: ReadonlyMap<string, string>,
): Changes {
  return {
    upload: [...local].filter(([key, etag]) => remote.get(key) !== etag).map(([key]) => key),
    remove: [...remote.keys()].filter((key) => !local.has(key)),
  };
}

export async function sync(agents: readonly AgentSpec[], stage: string): Promise<void> {
  const s3 = new S3Client();
  const bedrock = new BedrockAgentClient();
  try {
    for (const { name, knowledge } of agents) {
      const target = await findKnowledge(stage, name);
      if (target === undefined) {
        if (knowledge === undefined) continue;
        throw new Error(`${name} has knowledge/ but no deployed knowledge base. Deploy first.`);
      }
      const { upload, remove } = await mirror(s3, knowledge ?? noFiles, target.bucket);
      console.log(`${name}: ${String(upload)} uploaded, ${String(remove)} removed. Ingesting…`);
      console.log(`${name}: ${describe(await ingest(bedrock, target))}`);
    }
  } finally {
    s3.destroy();
    bedrock.destroy();
  }
}

const noFiles: KnowledgeFiles = { dir: '', files: [] };

async function mirror(
  s3: S3Client,
  { dir, files }: KnowledgeFiles,
  bucket: string,
): Promise<{ upload: number; remove: number }> {
  const contents = new Map(
    await Promise.all(
      files.map(
        async (file) => [file.split(sep).join('/'), await readFile(join(dir, file))] as const,
      ),
    ),
  );
  const local = new Map([...contents].map(([key, body]) => [key, etagOf(body)]));
  const { upload, remove } = diff(local, await listEtags(s3, bucket));

  for (const [key, body] of contents) {
    if (upload.includes(key))
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  }
  for (let start = 0; start < remove.length; start += maxDeletesPerRequest) {
    const keys = remove.slice(start, start + maxDeletesPerRequest);
    const { Errors } = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
    if (Errors !== undefined && Errors.length > 0) {
      const failures = Errors.map(({ Key, Message }) => `${String(Key)}: ${String(Message)}`);
      throw new Error(`Could not remove from ${bucket}:\n  ${failures.join('\n  ')}`);
    }
  }
  return { upload: upload.length, remove: remove.length };
}

async function listEtags(s3: S3Client, bucket: string): Promise<Map<string, string>> {
  const etags = new Map<string, string>();
  for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: bucket })) {
    for (const { Key, ETag } of page.Contents ?? []) {
      if (Key !== undefined && ETag !== undefined) etags.set(Key, ETag);
    }
  }
  return etags;
}

const maxDeletesPerRequest = 1000;

const etagOf = (body: Buffer): string => `"${createHash('md5').update(body).digest('hex')}"`;

const finished = new Set(['COMPLETE', 'FAILED', 'STOPPED']);
const pollMs = 5_000;
const timeoutMs = 15 * 60_000;

async function ingest(
  bedrock: BedrockAgentClient,
  { knowledgeBaseId, dataSourceId }: KnowledgeTarget,
): Promise<IngestionJob> {
  const started = await bedrock.send(
    new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }),
  );
  let job = started.ingestionJob;
  const deadline = Date.now() + timeoutMs;

  while (job?.ingestionJobId !== undefined && !finished.has(job.status ?? '')) {
    if (Date.now() > deadline) throw new Error(`Ingestion ${job.ingestionJobId} timed out`);
    await sleep(pollMs);
    const { ingestionJobId } = job;
    ({ ingestionJob: job } = await bedrock.send(
      new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }),
    ));
  }

  if (job === undefined) throw new Error('Bedrock did not return the ingestion job');
  const failed = job.statistics?.numberOfDocumentsFailed ?? 0;
  if (job.status !== 'COMPLETE' || failed > 0) {
    const reasons = job.failureReasons?.join('\n  ') ?? 'no reason given';
    throw new Error(`Ingestion ${String(job.status)}, ${String(failed)} failed:\n  ${reasons}`);
  }
  return job;
}

function describe({ statistics: s }: IngestionJob): string {
  const indexed =
    (s?.numberOfNewDocumentsIndexed ?? 0) + (s?.numberOfModifiedDocumentsIndexed ?? 0);
  return `${String(s?.numberOfDocumentsScanned ?? 0)} scanned, ${String(indexed)} indexed, ${String(s?.numberOfDocumentsDeleted ?? 0)} deleted`;
}
