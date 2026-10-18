import { build } from 'esbuild'
import { chmodSync, cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'src/bin.ts')],
  outfile: join(dist, 'deskmates.js'),
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})

const client = join(root, '../../packages/client/dist')
if (existsSync(client)) cpSync(client, join(dist, 'client'), { recursive: true })
else console.warn('WARNING: packages/client/dist is missing; this build has no UI and will serve the placeholder page. Build the client first.')
chmodSync(join(dist, 'deskmates.js'), 0o755)
