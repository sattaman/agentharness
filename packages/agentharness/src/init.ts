import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const template = fileURLToPath(new URL('../dist/template', import.meta.url));

export function init(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and isn't empty`);
  }
  cpSync(template, dir, { recursive: true });
  renameSync(join(dir, 'gitignore'), join(dir, '.gitignore'));

  const path = join(dir, 'package.json');
  const starter = z.looseObject({ name: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')));
  writeFileSync(path, `${JSON.stringify({ ...starter, name: packageName(dir) }, null, 2)}\n`);
}

const packageName = (dir: string): string =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
