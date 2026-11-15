import { build } from 'esbuild';

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
