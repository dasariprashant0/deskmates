#!/usr/bin/env node
// Load benchmark: 50 synthetic sessions, ~2 appended lines/s each, real server, 2 websocket clients.
//
//   node scripts/bench.mjs [--seconds 60] [--sessions 50] [--max-cpu 5] [--max-rss-mb 150]
//
// Everything (server, writer and both clients) runs in THIS process, so CPU and RSS are an upper bound for the
// server alone. Exit code 1 when mean CPU % > --max-cpu, max RSS > --max-rss-mb, any client was dropped, any frame was invalid,
// any seq gap was seen, or any client received no events. Prints one JSON object.
// Bundling: the packages are TypeScript-only, so scripts/_bundle.mjs bundles them with esbuild into $TMPDIR.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPieces } from './_bundle.mjs'

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  const v = i > -1 ? Number(process.argv[i + 1]) : dflt
  return Number.isFinite(v) && v > 0 ? v : dflt
}
const seconds = flag('seconds', 60)
const sessions = flag('sessions', 50)
const maxCpu = flag('max-cpu', 5)
const maxRssMB = flag('max-rss-mb', 150)
const TOKEN = 'benchTokenAbcdefghijklmnopqrstuvwxyz012_-'
const { startServer, WebSocket, createMirror, parseServerMessage, encodeResync } = await loadPieces()

const root = await mkdtemp(join(tmpdir(), 'dm-bench-root-'))
const home = await mkdtemp(join(tmpdir(), 'dm-bench-home-'))
const iso = (ms) => new Date(ms).toISOString()
const files = []
for (let s = 0; s < sessions; s++) {
  const dir = join(root, `-bench-p${s}`)
  await mkdir(dir, { recursive: true })
  const f = join(dir, `bench${s}.jsonl`)
  await writeFile(f, `${JSON.stringify({ type: 'user', sessionId: `bench${s}`, cwd: `/work/p${s}`, timestamp: iso(Date.now()), message: { role: 'user', content: 'synthetic' } })}\n`)
  files.push({ f, id: `bench${s}` })
}
// one tool call = two lines: assistant tool_use (+usage) then the user tool_result
let n = 0
const pair = ({ id }) => {
  const k = ++n
  const ts = iso(Date.now())
  return `${JSON.stringify({ type: 'assistant', sessionId: id, cwd: '/work/p', timestamp: ts, message: { id: `m${k}`, model: 'example-model', content: [{ type: 'tool_use', id: `tu${k}`, name: 'Read', input: { file_path: '/a/b.ts' } }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n${JSON.stringify({ type: 'user', sessionId: id, cwd: '/work/p', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: `tu${k}`, content: 'ok', is_error: false }] } })}\n`
}

const server = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN, claudeRoot: root, homeDir: home })
const stats = []
const clients = []
for (let c = 0; c < 2; c++) {
  const mirror = createMirror()
  const st = { events: 0, snapshots: 0, closed: false, invalid: 0 }
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ['deskmates.v1', TOKEN])
  ws.on('message', (d) => {
    const m = parseServerMessage(String(d))
    if (m.type === 'snapshot') { mirror.applySnapshot(m); st.snapshots++ }
    else if (m.type === 'events') { if (mirror.applyEvents(m) === 'gap') ws.send(encodeResync()); else st.events += m.events.length }
    else st.invalid++
  })
  ws.on('close', () => { st.closed = true })
  ws.on('error', () => { st.closed = true })
  clients.push({ ws, mirror, st })
  stats.push(st)
}

let failed = ''
try {
  const warm = Date.now() + 20_000
  while (Object.keys(server.bus.state().agents).length < sessions) {
    if (Date.now() > warm) throw new Error('warmup: sessions not discovered in 20s')
    await new Promise((r) => setTimeout(r, 100))
  }

  const rss = []
  const cpu = []
  let last = process.cpuUsage()
  let lastAt = process.hrtime.bigint()
  const writer = setInterval(() => { for (const x of files) void appendFile(x.f, pair(x)).catch(() => undefined) }, 1000)
  for (let s = 0; s < seconds; s++) {
    await new Promise((r) => setTimeout(r, 1000))
    const u = process.cpuUsage(last)
    const nowAt = process.hrtime.bigint()
    cpu.push(((u.user + u.system) / 1000 / (Number(nowAt - lastAt) / 1e6)) * 100) // µs -> ms over elapsed ms
    last = process.cpuUsage()
    lastAt = nowAt
    rss.push(process.memoryUsage().rss / 1048576)
  }
  clearInterval(writer)
  await new Promise((r) => setTimeout(r, 500)) // let the last flush land

  const sorted = [...rss].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  const r1 = (x) => Math.round(x * 10) / 10
  const ws = server.status().ws
  const result = {
    seconds, sessions, linesAppended: n * 2,
    rssMB: { p50: r1(pct(0.5)), p95: r1(pct(0.95)), max: r1(sorted.at(-1) ?? 0) },
    cpuMeanPct: r1(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)),
    clientEvents: stats.map((s) => s.events),
    resyncs: ws.resyncs,
    droppedClients: ws.droppedSlow + stats.filter((s) => s.closed).length,
    seqGaps: clients.reduce((a, c) => a + c.mirror.stats().gaps, 0),
    invalidFrames: stats.reduce((a, s) => a + s.invalid, 0),
    budget: { maxCpuPct: maxCpu, maxRssMB },
  }
  result.pass = result.cpuMeanPct <= maxCpu && result.rssMB.max <= maxRssMB
    && result.droppedClients === 0 && result.invalidFrames === 0 && result.seqGaps === 0
    && result.clientEvents.every((e) => e > 0) // a silent or stalled client must fail the run
  console.log(JSON.stringify(result))
  if (!result.pass) process.exitCode = 1
} catch (e) {
  failed = e instanceof Error ? e.message : 'error'
  console.error(`bench failed: ${failed}`)
  process.exitCode = 1
} finally {
  for (const c of clients) c.ws.terminate()
  await server.close()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}
