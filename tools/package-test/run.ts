import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDir = join(import.meta.dirname, '../../packages/agentharness');
const work = mkdtempSync(join(tmpdir(), 'agentharness-package-'));
const starter = join(work, 'starter');

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

run('pnpm', ['pack', '--pack-destination', work], packageDir);
const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
if (tarball === undefined) throw new Error('pnpm pack produced no tarball');

run(
  'npm',
  ['exec', '--yes', `--package=${join(work, tarball)}`, '--', 'agentharness', 'init', 'starter'],
  work,
);
run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', join(work, tarball)], starter);
run('npx', ['cdk', 'synth', '--quiet', '-c', 'stage=test'], starter);

const assets = readdirSync(join(starter, 'cdk.out')).filter((entry) => entry.startsWith('asset.'));
const handler = assets.some((asset) => existsSync(join(starter, 'cdk.out', asset, 'index.mjs')));
if (!handler) throw new Error('The synthesized app has no front-door Lambda asset');

console.log(`\nThe packed agentharness creates, installs and synthesizes a starter (${work}).`);
