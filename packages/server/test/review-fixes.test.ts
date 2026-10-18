import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXAMPLE_PRICES } from '@deskmates/core'
import type { SourceRef } from '@deskmates/provider-claude'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { EventBus } from '../src/bus'
import { createIngest } from '../src/ingest'
import { redactDeep } from '../src/redact'
import { Tailer } from '../src/tail'
import { createWsHub, type WsHub } from '../src/ws'

const TOKEN = 'tok-' + 'a'.repeat(28)
const ag = (id: string) => ({ provider: 'claude', sessionId: id })

describe('redactDeep masks API-key-looking tokens', () => {
  const f = (s: string) => redactDeep(s, '/Users/nobody')
  const fakes = [
    'sk-ant-api03-FAKEFAKEFAKEFAKE0123456789', 'sk-FAKEFAKEFAKEFAKEFAKE0123', 'ghp_FAKEFAKEFAKEFAKEFAKE0123456789',
    'AKIAFAKEFAKEFAKE1234', 'xoxb-1234567890-FAKEFAKE', 'xoxp-1234567890-FAKEFAKE',
    'eyJhbGciOiJGQUtF.eyJzdWIiOiJmYWtlIn0.FAKESIGNATURE0123',
  ]
  it.each(fakes)('masks %s', (k) => {
    expect(f(`Bash: curl -H "x: ${k}" end`)).toBe('Bash: curl -H "x: [redacted]" end')
    expect(f(k)).toBe('[redacted]')
  })
  it('walks nested values and keeps ordinary text', () => {
    const out = redactDeep({ a: ['task-abcdefghijklmnopqrstuvwxyz', { b: 'sk-FAKEFAKEFAKEFAKEFAKE0123' }], n: 5 }, '/Users/nobody')
    expect(out).toEqual({ a: ['task-abcdefghijklmnopqrstuvwxyz', { b: '[redacted]' }], n: 5 })
  })
  it('still redacts the home dir alongside', () => {
    expect(redactDeep('/Users/nobody/x sk-FAKEFAKEFAKEFAKEFAKE0123', '/Users/nobody')).toBe('~/x [redacted]')
  })
})

describe('ws frame caps', () => {
  let hub: WsHub | undefined
  let server: http.Server | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate()
    await hub?.close()
    server?.closeAllConnections()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  })
  const boot = async (bus: EventBus, n: number, o: { maxFrameBytes: number; flushMs?: number }) => {
    let port = 0
    hub = createWsHub({ bus, token: TOKEN, getPort: () => port, getExtras: () => ({ prices: EXAMPLE_PRICES, pricesAreExample: true }), homeDir: '/Users/nobody', ...o })
    server = http.createServer()
    server.on('upgrade', hub.handleUpgrade)
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    return Array.from({ length: n }, () => {
      const raw: string[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', TOKEN])
      sockets.push(ws)
      ws.on('message', (d) => raw.push(d.toString()))
      return { raw }
    })
  }
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true) }

  it('trims an oversized snapshot: ended agents go first, oldest first, live agents stay', async () => {
    const bus = new EventBus()
    bus.publish({ ts: 1, agent: ag('live'), kind: 'session.start', cwd: '/live' })
    for (let i = 0; i < 100; i++) {
      bus.publish({ ts: 10 + i, agent: ag(`e${i}`), kind: 'session.start', cwd: 'x'.repeat(4000) })
      bus.publish({ ts: 10 + i, agent: ag(`e${i}`), kind: 'agent.end', reason: 'stop' })
    }
    const cap = 100_000
    const [c] = await boot(bus, 1, { maxFrameBytes: cap })
    await until(() => c!.raw.length > 0)
    const raw = c!.raw[0]!
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(cap)
    const snap = JSON.parse(raw) as { seq: number; state: { agents: Record<string, unknown>; order: string[] } }
    expect(snap.seq).toBe(bus.seq())
    expect(snap.state.agents['claude:live:main']).toBeDefined()
    expect(snap.state.agents['claude:e99:main']).toBeDefined() // newest ended survives
    expect(snap.state.agents['claude:e0:main']).toBeUndefined() // oldest ended dropped
    expect(snap.state.order.every((k) => k in snap.state.agents)).toBe(true)
  })

  it('splits an oversized events batch into frames under the cap, contiguous and complete', async () => {
    const bus = new EventBus()
    const cap = 20_000
    const clients = await boot(bus, 2, { maxFrameBytes: cap, flushMs: 150 })
    await until(() => clients.every((c) => c.raw.length === 1))
    const first = bus.seq()
    for (let i = 0; i < 30; i++) bus.publish({ ts: 100 + i, agent: ag('s'), kind: 'tool.start', toolUseId: `t${i}`, name: 'N', summary: 'y'.repeat(3000) })
    await until(() => clients.every((c) => c.raw.length >= 3))
    await new Promise((r) => setTimeout(r, 300))
    for (const c of clients) {
      const frames = c.raw.slice(1).map((r) => JSON.parse(r) as { fromSeq: number; toSeq: number; events: { seq: number }[] })
      expect(frames.length).toBeGreaterThan(1)
      for (const r of c.raw.slice(1)) expect(Buffer.byteLength(r)).toBeLessThanOrEqual(cap)
      const seqs = frames.flatMap((f) => f.events.map((e) => e.seq))
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => first + 1 + i))
      for (const f of frames) { expect(f.fromSeq).toBe(f.events[0]!.seq); expect(f.toSeq).toBe(f.events.at(-1)!.seq) }
    }
    expect(clients[1]!.raw.slice(1)).toEqual(clients[0]!.raw.slice(1)) // same strings for same batch
  })

  it('counts a socket error in the rejected counters', async () => {
    const bus = new EventBus()
    await boot(bus, 1, { maxFrameBytes: 100_000 })
    await until(() => hub!.stats().clients === 1)
    hub!.handleUpgrade({ url: '/ws', rawHeaders: [], headers: {} } as unknown as http.IncomingMessage, { on: (_e: string, f: () => void) => f(), write: () => true, destroy: () => undefined } as never, Buffer.alloc(0))
    expect(hub!.stats().rejected['socket-error']).toBe(1)
  })
})

describe('tailer', () => {
  const src = (filePath: string): SourceRef => ({ provider: 'claude', filePath, sessionId: 's', isSubagent: false })
  const fake = (size: number, mtimeMs: number) => ({
    stat: async () => ({ ino: 1, size, mtimeMs }),
    read: async () => ({ bytesRead: 0 }),
    close: async () => undefined,
  })

  it('stats an old unchanged file every 2 s, a fresh one every poll', async () => {
    let t = 1_000_000
    let stats = 0
    const tl = new Tailer({
      onLine: () => undefined, now: () => t, recentMs: Infinity,
      openFile: async () => fake(0, 0),
      statFile: async () => { stats++; return { ino: 1, size: 0, mtimeMs: 0 } },
    })
    tl.add(src('/x/old.jsonl'))
    await tl.poll() // first sight: open, no statFile
    for (let i = 0; i < 8; i++) { t += 250; await tl.poll() } // 2 s of 250 ms polls
    expect(stats).toBeLessThanOrEqual(2)
    // fresh file: mtime within 60 s keeps one stat per poll
    const fixed = t
    const f2 = new Tailer({
      onLine: () => undefined, now: () => t, recentMs: Infinity,
      openFile: async () => fake(0, fixed),
      statFile: async () => { stats++; return { ino: 1, size: 0, mtimeMs: fixed } },
    })
    stats = 0
    f2.add(src('/x/new2.jsonl'))
    await f2.poll()
    for (let i = 0; i < 8; i++) { t += 250; await f2.poll() }
    expect(stats).toBe(8)
  })

  it('an idle file that then grows is picked up within the recheck window', async () => {
    const d = await mkdtemp(join(tmpdir(), 'dm-idle-'))
    try {
      const p = join(d, 'a.jsonl')
      await writeFile(p, 'one\n')
      const lines: string[] = []
      const { utimes } = await import('node:fs/promises')
      await utimes(p, 1000, 1000) // ancient mtime
      let t = Date.now()
      const tl = new Tailer({ onLine: (e) => lines.push(e.line), now: () => t, recentMs: Infinity })
      tl.add(src(p)); await tl.poll(); await tl.poll()
      await appendFile(p, 'two\n')
      await tl.poll() // inside the 2 s quiet window: skipped
      expect(lines).toEqual(['one'])
      t += 2100
      await tl.poll()
      expect(lines).toEqual(['one', 'two'])
    } finally { await rm(d, { recursive: true, force: true }) }
  })

  it('backfills only the last backfillMaxBytes of a big recent file, from a line boundary', async () => {
    const d = await mkdtemp(join(tmpdir(), 'dm-bf-'))
    try {
      const p = join(d, 'big.jsonl')
      const rows = Array.from({ length: 1000 }, (_, i) => `line-${String(i).padStart(4, '0')}`) // 10 bytes each with \n
      await writeFile(p, rows.join('\n') + '\n')
      const lines: string[] = []
      const tl = new Tailer({ onLine: (e) => lines.push(e.line), backfillMaxBytes: 255, recentMs: 600_000 })
      tl.add(src(p)); await tl.poll()
      // start = 10000-255 = 9745 -> inside line 974 (bytes 9740..9749): that partial line is dropped
      expect(lines[0]).toBe('line-0975')
      expect(lines.at(-1)).toBe('line-0999')
      expect(lines).toHaveLength(25)
      expect(tl.stats().skippedOversize).toBe(1) // the cut line is counted
      await appendFile(p, 'tail\n')
      await tl.poll()
      expect(lines.at(-1)).toBe('tail')
    } finally { await rm(d, { recursive: true, force: true }) }
  })
})

describe('ingest failure reporting', () => {
  it('surfaces tailer failures through warn("poll", code), once', async () => {
    const d = await mkdtemp(join(tmpdir(), 'dm-ing-'))
    try {
      const warns: string[] = []
      const ing = createIngest({
        root: d, bus: new EventBus(),
        warn: (c, x) => { if (x?.where === 'poll') warns.push(c) },
        deps: {
          discover: async () => [{ provider: 'claude', filePath: join(d, 'f.jsonl'), sessionId: 'f', isSubagent: false }],
          openFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) },
        },
      })
      await ing.scanOnce()
      await ing.pollOnce()
      await ing.pollOnce()
      expect(warns).toEqual(['EACCES']) // once, not per poll
    } finally { await rm(d, { recursive: true, force: true }) }
  })
})
