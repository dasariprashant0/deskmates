import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '@deskmates/server'
import { createMirror, parseServerMessage, type Mirror } from '../../../packages/client/src/net'

type Sock = {
  on(e: 'message', cb: (d: unknown) => void): void
  on(e: 'close', cb: (code: number) => void): void
  on(e: 'error', cb: (err: Error) => void): void
  on(e: 'open', cb: () => void): void
  on(e: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): void
  terminate(): void
}
type SockCtor = new (url: string, protocols: string[], opts?: { headers?: Record<string, string> }) => Sock
// `ws` is a dependency of @deskmates/server only, so resolve it from there (same as smoke.test.ts).
const WebSocket = (createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../packages/server/package.json'))('ws') as { WebSocket: SockCtor }).WebSocket

const TOKEN = 'e2eTokenAbcdefghijklmnopqrstuvwxyz0123_-'
const MAIN = 'claude:sessE2E:main'
const iso = (ms: number) => new Date(ms).toISOString()
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const asst = (o: { ts: number; msgId: string; toolId: string; tool: string; input: number; output: number }) => JSON.stringify({
  type: 'assistant', sessionId: 'sessE2E', cwd: '/work/proj', timestamp: iso(o.ts),
  message: {
    id: o.msgId, model: 'example-model',
    content: [{ type: 'tool_use', id: o.toolId, name: o.tool, input: { file_path: '/a/b.ts', command: 'ls' } }],
    usage: { input_tokens: o.input, output_tokens: o.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
})
const result = (ts: number, id: string) => JSON.stringify({
  type: 'user', sessionId: 'sessE2E', cwd: '/work/proj', timestamp: iso(ts),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
})

type Client = { sock: Sock; mirror: Mirror; frames: string[]; invalid: () => number; closed: () => number | undefined }
const connect = (port: number, token = TOKEN): Promise<Client> => new Promise((resolve, reject) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', token])
  const mirror = createMirror()
  const frames: string[] = []
  let closedCode: number | undefined
  let invalid = 0
  sock.on('message', (d) => {
    const text = String(d)
    frames.push(text)
    const m = parseServerMessage(text)
    if (m.type === 'snapshot') mirror.applySnapshot(m)
    else if (m.type === 'events') mirror.applyEvents(m)
    else invalid++
  })
  sock.on('close', (c) => { closedCode = c })
  sock.on('error', reject)
  sock.on('open', () => resolve({ sock, mirror, frames, invalid: () => invalid, closed: () => closedCode }))
})

// Resolves with the HTTP status of a refused upgrade.
const refused = (port: number, token: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', token], { headers })
  sock.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); sock.terminate() })
  sock.on('open', () => { sock.terminate(); reject(new Error('connection was accepted')) })
  sock.on('error', () => undefined)
})

let root: string
let home: string
let server: RunningServer | undefined
const socks: Sock[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dm-e2e-root-'))
  home = await mkdtemp(join(tmpdir(), 'dm-e2e-home-'))
})
afterEach(async () => {
  for (const s of socks.splice(0)) s.terminate()
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('end to end: transcript file -> server -> websocket -> client mirror', () => {
  it('streams appended chunks (incl. a split line) into the mirror; a late client gets an equal snapshot; bad token/origin are refused; close() resolves', async () => {
    const dir = join(root, '-work-proj')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'sessE2E.jsonl')
    const now = Date.now()
    await writeFile(file, `${asst({ ts: now - 5000, msgId: 'm1', toolId: 'tu1', tool: 'Read', input: 10, output: 5 })}\n`)

    server = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN, claudeRoot: root, homeDir: home, ingest: { scanMs: 50, pollMs: 50 } })
    const a = await connect(server.port)
    socks.push(a.sock)
    await until(() => (a.mirror.state().agents[MAIN]?.openOrder ?? []).includes('tu1'))
    expect(a.frames[0]).toContain('"type":"snapshot"')

    // chunk 1: a whole line closing tu1
    await appendFile(file, `${result(now - 4000, 'tu1')}\n`)
    await until(() => (a.mirror.state().agents[MAIN]?.openOrder ?? []).length === 0)

    // chunk 2 + 3: one line split mid-way, no newline until the second write
    const line = asst({ ts: now - 3000, msgId: 'm2', toolId: 'tu2', tool: 'Bash', input: 100, output: 50 })
    const cut = Math.floor(line.length / 2)
    await appendFile(file, line.slice(0, cut))
    await new Promise((r) => setTimeout(r, 250)) // several polls pass; the partial line must not surface
    expect(a.mirror.state().agents[MAIN]?.openOrder).toEqual([])
    await appendFile(file, `${line.slice(cut)}\n`)

    await until(() => a.mirror.state().agents[MAIN]?.openOrder.includes('tu2') === true && a.mirror.seq() === server!.bus.seq())
    const agent = a.mirror.state().agents[MAIN]!
    expect(Object.keys(agent.openTools)).toEqual(['tu2'])
    expect(agent.currentTool?.name).toBe('Bash')
    expect(agent.usage).toEqual({ input: 110, cacheWrite: 0, cacheRead: 0, output: 55 })
    expect(agent.cwd).toBe('/work/proj')
    expect(a.mirror.stats().gaps).toBe(0)
    expect(a.invalid()).toBe(0)
    // the client mirror agrees with the server's own bus
    expect(a.mirror.seq()).toBe(server.bus.seq())

    // a later client starts from a snapshot equal to the first client's accumulated state
    const b = await connect(server.port)
    socks.push(b.sock)
    await until(() => b.mirror.stats().snapshots === 1)
    expect(b.frames[0]).toContain('"type":"snapshot"')
    expect(b.mirror.seq()).toBe(a.mirror.seq())
    expect(b.mirror.state()).toEqual(a.mirror.state())

    // refusals
    expect(await refused(server.port, `${TOKEN.slice(0, -1)}X`)).toBe(401)
    expect(await refused(server.port, TOKEN, { Origin: 'https://evil.example' })).toBe(403)

    // close() resolves and tells connected clients we are going away
    await expect(server.close()).resolves.toBeUndefined()
    await until(() => a.closed() !== undefined && b.closed() !== undefined)
    expect(a.closed()).toBe(1001)
  }, 30_000)
})
