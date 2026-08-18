/**
 * Publishable build: one self-contained ESM bundle per entry, with the
 * workspace protocol package inlined so `npx sloppers` needs nothing but
 * its real npm dependencies. Type checking stays tsc's job (`typecheck`).
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: here,
  entryPoints: ['src/cli.ts', 'src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  packages: 'external',
  alias: { '@sloppers/protocol': '../protocol/src/index.ts' },
  logLevel: 'info',
});
