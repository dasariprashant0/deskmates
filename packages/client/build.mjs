import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [join(root, 'src/app.ts')],
  outfile: join(dist, 'app.js'),
  bundle: true, platform: 'browser', target: 'es2022', format: 'iife', minify: true, sourcemap: false,
  logLevel: 'warning',
})
cpSync(join(root, 'public'), dist, { recursive: true })
