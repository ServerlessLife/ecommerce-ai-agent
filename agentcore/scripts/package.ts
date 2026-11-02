/**
 * Stage the AgentCore Runtime artifact into `agentcore/agentcore-package/` —
 * the dir `infra/lib/AgentCoreStack.ts` zips as a CDK code asset. Layout:
 *
 *   package.json                    # "type": "module" — .js entrypoints parse as ESM
 *   dist/agentcore/server.js        # esbuild ESM bundle, everything inlined
 *   dist/agentcore/bootstrap.js     # `import './server.js'` — the entrypoint
 *
 * Run via `npm run package` (chained by the root deploy/synth scripts — the
 * staging dir must exist before `cdk synth`).
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = path.join(agentDir, 'agentcore-package');
const entrypoint = 'dist/agentcore/bootstrap.js';

await rm(stagingDir, { recursive: true, force: true });
const stagingAgentCoreDir = path.join(stagingDir, 'dist', 'agentcore');
await mkdir(stagingAgentCoreDir, { recursive: true });

await build({
  entryPoints: [path.join(agentDir, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  outfile: path.join(stagingAgentCoreDir, 'server.js'),
  // Inlined CJS packages may call require() at runtime — give the ESM bundle a shim.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

await writeFile(path.join(stagingAgentCoreDir, 'bootstrap.js'), `import './server.js';\n`, 'utf-8');
await writeFile(
  path.join(stagingDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'sample-agent-artifact',
      version: '0.1.0',
      private: true,
      type: 'module',
    },
    null,
    2,
  )}\n`,
  'utf-8',
);

const { size } = await stat(path.join(stagingAgentCoreDir, 'server.js'));
console.log(
  `AgentCore artifact staged: ${stagingDir}\n` +
    `  entrypoint: ${entrypoint} (NODE_22, ESM via manifest "type": "module")\n` +
    `  bundle: ${(size / 1024 / 1024).toFixed(1)} MB`,
);
