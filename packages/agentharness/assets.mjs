import { build } from 'esbuild';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';

await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/handler/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const example = '../../examples/helper';
const template = 'dist/template';
for (const path of ['agents', 'callers.json', 'cdk.json', 'README.md']) {
  cpSync(`${example}/${path}`, `${template}/${path}`, { recursive: true });
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const starter = JSON.parse(readFileSync(`${example}/package.json`, 'utf8'));
starter.devDependencies.agentharness = `^${version}`;
writeFileSync(`${template}/package.json`, `${JSON.stringify(starter, null, 2)}\n`);
// npm drops .gitignore files from packages, so the template ships it under another name.
writeFileSync(`${template}/gitignore`, 'node_modules/\ncdk.out/\ncdk.context.json\n');
