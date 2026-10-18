// Shared by smoke-real.mjs and bench.mjs. The workspace packages are TypeScript-only (main: src/index.ts),
// so bundle the server, the client net layer and `ws` with esbuild into $TMPDIR and import the result.
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

export const loadPieces = async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'dm-script-')), 'pieces.mjs')
  await build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(join(repo, 'packages/server/src/index.ts'))}`,
        `export * from ${JSON.stringify(join(repo, 'packages/client/src/net/index.ts'))}`,
        `export { discover, newDiscoverDiag, parseLine, newParseCtx, newParseDiag } from ${JSON.stringify(join(repo, 'packages/provider-claude/src/index.ts'))}`,
        "export { WebSocket } from 'ws'",
      ].join('\n'),
      resolveDir: join(repo, 'packages/server'),
      loader: 'ts',
    },
    outfile: out, bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'warning',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  return import(pathToFileURL(out).href)
}
