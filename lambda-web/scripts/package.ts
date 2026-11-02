/**
 * Stage the Lambda Web Function package into `lambda-web-package/` — uploaded
 * to the packages bucket and published as the web function revision by
 * `infra/lib/AgentLambdaWebStack.ts`. One CJS esbuild bundle at the zip root
 * (`index.js` — the runtime's default entry), everything inlined.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspaceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = path.join(workspaceDir, 'lambda-web-package');

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

await build({
  entryPoints: [path.join(workspaceDir, 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  outfile: path.join(stagingDir, 'index.js'),
});

const { size } = await stat(path.join(stagingDir, 'index.js'));
console.log(
  `LambdaWeb package staged: ${stagingDir}\n` +
    `  entry: index.js (package root — the runtime's default entry, CJS)\n` +
    `  bundle: ${(size / 1024 / 1024).toFixed(1)} MB`,
);
