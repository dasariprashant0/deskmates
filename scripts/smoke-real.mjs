#!/usr/bin/env node
// Structure-only smoke against real transcripts. Prints ONE JSON object of counts; never any content,
// file name or path (an assertion at the end enforces that no output contains the root or the home dir).
//
//   node scripts/smoke-real.mjs [--root <dir>]      (default ~/.claude/projects)
//
// How it runs: the workspace packages are TypeScript-only, so scripts/_bundle.mjs bundles them with
// esbuild (a root devDependency) into $TMPDIR and imports the result. It uses the real discover(),
// Tailer (read whole files, not just the tail), parseLine() and EventBus (so the reducer runs on real data).
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadPieces } from './_bundle.mjs'

const i = process.argv.indexOf('--root')
const root = resolve(i > -1 && process.argv[i + 1] ? process.argv[i + 1] : join(homedir(), '.claude', 'projects'))
const t0 = Date.now()
const { discover, newDiscoverDiag, parseLine, newParseCtx, newParseDiag, Tailer, EventBus } = await loadPieces()

const out = { sessions: 0, subagentFiles: 0, lines: 0, eventsByKind: {}, parseErrors: 0, unknownLines: 0, ignoredLines: 0, reducerErrors: 0, skippedDirs: 0, skippedFiles: 0, rootReadable: true, elapsedMs: 0, rssMB: 0 }
const diag = newParseDiag()
const dd = newDiscoverDiag()
const bus = new EventBus({ capacity: 100 })
const ctxs = new Map()
const tailer = new Tailer({
  recentMs: Infinity,
  onLine: ({ src, line }) => {
    out.lines++
    let ctx = ctxs.get(src.filePath)
    if (!ctx) { ctx = newParseCtx(); ctxs.set(src.filePath, ctx) }
    for (const ev of parseLine(src, line, ctx, Date.now(), diag)) {
      out.eventsByKind[ev.kind] = (out.eventsByKind[ev.kind] ?? 0) + 1
      try { bus.publish(ev) } catch { out.reducerErrors++ }
    }
  },
})

const found = await discover({ root, maxAgeMs: Number.MAX_SAFE_INTEGER / 2, now: Date.now() }, dd)
out.rootReadable = dd.rootError === undefined
for (const s of found) {
  if (s.isSubagent) out.subagentFiles++
  else out.sessions++
  tailer.add(s)
}
await tailer.poll()
await tailer.poll() // second pass picks up anything appended meanwhile

out.parseErrors = diag.malformed + diag.oversize + diag.internalError
out.unknownLines = diag.unrecognized
out.ignoredLines = diag.ignored
out.skippedDirs = dd.skippedDirs
out.skippedFiles = dd.skippedFiles
out.agents = Object.keys(bus.state().agents).length
out.elapsedMs = Date.now() - t0
out.rssMB = Math.round(process.memoryUsage().rss / 1048576)

const text = JSON.stringify(out)
for (const secret of [root, homedir()]) {
  if (secret.length > 1 && text.includes(secret)) { console.error('smoke-real: output would contain a path; refusing to print'); process.exit(2) }
}
console.log(text)
