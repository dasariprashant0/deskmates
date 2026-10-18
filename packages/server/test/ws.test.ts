import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXAMPLE_PRICES } from '@deskmates/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { EventBus } from '../src/bus'
import { createIngest } from '../src/ingest'
import { createWsHub, type WsHub, type WsOpts } from '../src/ws'

const TOKEN = 'tok-' + 'a'.repeat(28)
const PROTO = 'deskmates.v1'
const ag = { provider: 'claude', sessionId: 's1' }
type Msg = { type: string; [k: string]: unknown }

let bus: EventBus
let hub: WsHub
let server: http.Server
let port = 0
const toClose: Array<() => void> = []

const until = async (fn: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const start = async (o: Partial<WsOpts> = {}) => {
  bus = new EventBus()
  hub = createWsHub({ bus, token: TOKEN, getPort: () => port, getExtras: () => ({ prices: EXAMPLE_PRICES, pricesAreExample: true }), flushMs: 30, ...o })
  server = http.createServer((_q, r) => { r.statusCode = 404; r.end() })
  server.on('upgrade', hub.handleUpgrade)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as net.AddressInfo).port
}

afterEach(async () => {
  for (const f of toClose.splice(0)) f()
  await hub.close()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

type Conn = { ws: WebSocket; msgs: Msg[]; raw: string[]; closed: { code: number } | undefined; headers: http.IncomingHttpHeaders }
type Attempt = { conn: Conn } | { status: number }

const attempt = (path: string, protocols: string[] | undefined, headers: Record<string, string> = {}): Promise<Attempt> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers, perMessageDeflate: false })
    const conn: Conn = { ws, msgs: [], raw: [], closed: undefined, headers: {} }
    toClose.push(() => ws.terminate())
    ws.on('message', (d) => { const s = d.toString(); conn.raw.push(s); conn.msgs.push(JSON.parse(s) as Msg) })
    ws.on('close', (code) => { conn.closed = { code } })
    ws.on('upgrade', (res) => { conn.headers = res.headers })
    ws.on('open', () => resolve({ conn }))
    ws.on('unexpected-response', (_q, res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }) })
    ws.on('error', () => resolve({ status: 0 }))
  })

const connect = async (o: { protocols?: string[]; headers?: Record<string, string> } = {}): Promise<Conn> => {
  const r = await attempt('/ws', o.protocols ?? [PROTO, TOKEN], o.headers)
  if (!('conn' in r)) throw new Error(`refused ${r.status}`)
  return r.conn
}

// raw handshake so Host and headers are fully controlled; returns status and the open socket
const rawHandshake = (lines: string[]): Promise<{ status: number; socket: net.Socket }> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    toClose.push(() => socket.destroy())
    let buf = ''
    socket.on('error', reject)
    socket.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n')) resolve({ status: Number(buf.split(' ')[1] ?? 0), socket })
    })
    socket.write(lines.join('\r\n') + '\r\n\r\n')
  })
const upgradeLines = (host: string, proto: string) => [
  'GET /ws HTTP/1.1', `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
  'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`,
  `Sec-WebSocket-Protocol: ${proto}`,
]

const pub = (id: string, summary = '') => bus.publish({ ts: Date.now(), agent: ag, kind: 'tool.start', toolUseId: id, name: 'Read', summary })
const first = (c: Conn): Msg => { const m = c.msgs[0]; if (!m) throw new Error('no message'); return m }
const batches = (c: Conn) => c.msgs.filter((m) => m.type === 'events')

describe('upgrade validation', () => {
  beforeEach(() => start())

  it('refuses without the subprotocol token', async () => {
    expect(await attempt('/ws', undefined)).toEqual({ status: 401 })
    expect(await attempt('/ws', [PROTO])).toEqual({ status: 401 })
  })
  it('refuses a wrong token and a token in the wrong position', async () => {
    expect(await attempt('/ws', [PROTO, 'nope'])).toEqual({ status: 401 })
    expect(await attempt('/ws', [TOKEN, PROTO])).toEqual({ status: 401 })
    expect(await attempt('/ws', [PROTO, TOKEN, 'extra'])).toEqual({ status: 401 })
  })
  it('does not accept a query-string token', async () => {
    const r = await attempt(`/ws?t=${TOKEN}`, undefined)
    expect('status' in r && r.status >= 400).toBe(true)
    expect(await attempt(`/ws?t=${TOKEN}`, [PROTO])).not.toHaveProperty('conn')
  })
  it('404 for another path', async () => {
    expect(await attempt('/other', [PROTO, TOKEN])).toEqual({ status: 404 })
  })
  it('evil Origin gets 403', async () => {
    expect(await attempt('/ws', [PROTO, TOKEN], { Origin: 'https://evil.com' })).toEqual({ status: 403 })
  })
  it('wrong Host via raw socket gets 403', async () => {
    const r = await rawHandshake(upgradeLines('evil.com:' + port, `${PROTO}, ${TOKEN}`))
    expect(r.status).toBe(403)
    const ok = await rawHandshake(upgradeLines(`127.0.0.1:${port}`, `${PROTO}, ${TOKEN}`))
    expect(ok.status).toBe(101)
    expect(hub.stats().rejected['bad-host']).toBe(1)
  })
  it('absent Origin with the right token is accepted; same-origin Origin too', async () => {
    const c = await connect()
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
    const d = await connect({ headers: { Origin: `http://127.0.0.1:${port}` } })
    expect(d.ws.readyState).toBe(WebSocket.OPEN)
  })
  it('counts rejections by fixed reason codes', async () => {
    await attempt('/ws', [PROTO, 'nope'])
    await attempt('/x', [PROTO, TOKEN])
    await attempt('/ws', [PROTO, TOKEN], { Origin: 'https://evil.com' })
    expect(hub.stats().rejected).toEqual({ 'bad-token': 1, 'bad-path': 1, 'bad-origin': 1 })
  })
  it('negotiates exactly deskmates.v1 and never echoes the token', async () => {
    const c = await connect()
    expect(c.ws.protocol).toBe(PROTO)
    pub('t1')
    await until(() => batches(c).length > 0)
    expect(JSON.stringify(c.headers)).not.toContain(TOKEN)
    expect(c.raw.join('')).not.toContain(TOKEN)
    const bad = await attempt('/ws', [PROTO, 'nope'])
    expect(JSON.stringify(bad)).not.toContain(TOKEN)
  })
  it('survives a client that errors during the handshake', async () => {
    const s = net.connect(port, '127.0.0.1')
    await new Promise((r) => s.once('connect', r))
    s.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    s.destroy()
    expect((await connect()).ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('maxClients', () => {
  beforeEach(() => start({ maxClients: 2 }))
  it('answers 503 full beyond the limit', async () => {
    await connect(); await connect()
    expect(await attempt('/ws', [PROTO, TOKEN])).toEqual({ status: 503 })
    expect(hub.stats().rejected['full']).toBe(1)
    expect(hub.stats().clients).toBe(2)
  })
})

describe('streaming', () => {
  beforeEach(() => start())

  it('sends a snapshot first with seq and state', async () => {
    pub('t0')
    const c = await connect()
    await until(() => c.msgs.length > 0)
    const m = first(c)
    expect(m).toMatchObject({ type: 'snapshot', v: 1, seq: 1, pricesAreExample: true })
    expect(Object.keys((m.state as { agents: object }).agents)).toHaveLength(1)
    expect(m.prices).toBeTruthy()
  })

  it('puts several publishes inside one flush window into ONE batch', async () => {
    const c = await connect()
    await until(() => c.msgs.length > 0)
    pub('a'); pub('b'); pub('c')
    await until(() => batches(c).length > 0)
    await new Promise((r) => setTimeout(r, 120))
    expect(batches(c)).toHaveLength(1)
    expect(batches(c)[0]).toMatchObject({ fromSeq: 1, toSeq: 3 })
    expect((batches(c)[0]?.events as unknown[]).length).toBe(3)
  })

  it('resync returns a fresh snapshot and clears the queue', async () => {
    const c = await connect()
    await until(() => c.msgs.length > 0)
    pub('a'); pub('b')
    c.ws.send(JSON.stringify({ type: 'resync' }))
    await until(() => c.msgs.filter((m) => m.type === 'snapshot').length === 2)
    const snap = c.msgs.filter((m) => m.type === 'snapshot')[1]
    expect(snap?.seq).toBe(2)
    await new Promise((r) => setTimeout(r, 120))
    expect(batches(c)).toHaveLength(0)
    expect(hub.stats().resyncs).toBe(1)
  })

  it('invalid JSON, non-object, binary and missing type close 1008', async () => {
    for (const payload of ['{not json', '42', 'null', '[1]', '{}', '{"type":5}', Buffer.from([1, 2, 3])]) {
      const c = await connect()
      c.ws.send(payload)
      await until(() => c.closed !== undefined)
      expect(c.closed?.code).toBe(1008)
    }
  })

  it('oversized payload closes 1009', async () => {
    const c = await connect()
    c.ws.send('x'.repeat(5000))
    await until(() => c.closed !== undefined)
    expect(c.closed?.code).toBe(1009)
  })

  it('ignores unknown messages, counts them, closes 1008 after 20', async () => {
    const c = await connect()
    for (let i = 0; i < 19; i++) c.ws.send(JSON.stringify({ type: 'approve', id: i }))
    await until(() => hub.stats().ignoredMessages === 19)
    expect(c.closed).toBeUndefined()
    c.ws.send(JSON.stringify({ type: 'approve' }))
    await until(() => c.closed !== undefined)
    expect(c.closed?.code).toBe(1008)
    expect(hub.stats().ignoredMessages).toBe(20)
  })

  it('never echoes client data', async () => {
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'zzz-marker-xyz' }))
    c.ws.send('{zzz-marker-xyz')
    await until(() => c.closed !== undefined)
    expect(c.raw.join('')).not.toContain('zzz-marker-xyz')
  })

  it('a synthetic transcript line driven through ingest arrives as a contiguous tool.start batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dm-ws-'))
    try {
      const iso = (ms: number) => new Date(ms).toISOString()
      const line = (id: string) => JSON.stringify({
        type: 'assistant', sessionId: 'sess', cwd: '/work/proj', timestamp: iso(Date.now()),
        message: { id: `m-${id}`, model: 'example-model', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a/b.ts' } }] },
      })
      const dir = join(root, '-work-proj')
      await mkdir(dir, { recursive: true })
      const f = join(dir, 'sess.jsonl')
      await writeFile(f, `${line('tu1')}\n`)
      const ing = createIngest({ root, bus })
      await ing.scanOnce(); await ing.pollOnce()
      const c = await connect()
      await until(() => c.msgs.length > 0)
      const snapSeq = first(c).seq as number
      expect(snapSeq).toBeGreaterThan(0)
      await appendFile(f, `${line('tu2')}\n`)
      await ing.pollOnce()
      await until(() => batches(c).length > 0)
      const b = batches(c)[0]
      const events = (b?.events ?? []) as Array<{ seq: number; kind: string }>
      expect(b?.fromSeq).toBe(snapSeq + 1)
      expect(b?.toSeq).toBe(events[events.length - 1]?.seq)
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => snapSeq + 1 + i))
      expect(events.some((e) => e.kind === 'tool.start')).toBe(true)
      await ing.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('queue overflow', () => {
  beforeEach(() => start({ maxQueued: 3 }))
  it('replaces an overflowing queue with a fresh snapshot', async () => {
    const c = await connect()
    await until(() => c.msgs.length > 0)
    for (let i = 0; i < 10; i++) pub(`t${i}`)
    await until(() => c.msgs.filter((m) => m.type === 'snapshot').length === 2)
    expect(c.msgs.filter((m) => m.type === 'snapshot')[1]?.seq).toBe(10)
    await new Promise((r) => setTimeout(r, 100))
    expect(batches(c)).toHaveLength(0)
    expect(hub.stats().resyncs).toBe(1)
    pub('after')
    await until(() => batches(c).length === 1)
    expect(batches(c)[0]).toMatchObject({ fromSeq: 11, toSeq: 11 })
  })
})

describe('backpressure and heartbeat', () => {
  it('terminates a slow client without affecting others', async () => {
    await start({ maxBufferedBytes: 200_000, flushMs: 10 })
    const good = await connect()
    const slow = await rawHandshake(upgradeLines(`127.0.0.1:${port}`, `${PROTO}, ${TOKEN}`))
    slow.socket.pause() // never read
    await until(() => hub.stats().clients === 2)
    const big = 'x'.repeat(400_000)
    let i = 0
    const end = Date.now() + 20_000
    while (hub.stats().droppedSlow === 0 && Date.now() < end) {
      pub(`big${i++}`, big)
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(hub.stats().droppedSlow).toBe(1)
    expect(hub.stats().clients).toBe(1)
    const seen = batches(good).length
    pub('still-here')
    await until(() => batches(good).length > seen)
    expect(good.ws.readyState).toBe(WebSocket.OPEN)
  }, 30_000)

  it('terminates a client that never pongs', async () => {
    await start({ pingMs: 50 })
    const mute = await rawHandshake(upgradeLines(`127.0.0.1:${port}`, `${PROTO}, ${TOKEN}`))
    expect(mute.status).toBe(101) // raw socket never answers pings
    await until(() => hub.stats().clients === 1)
    await until(() => hub.stats().clients === 0)
    const live = await connect() // a real client answers pings automatically and stays
    await new Promise((r) => setTimeout(r, 250))
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    expect(hub.stats().clients).toBe(1)
  })
})

describe('close', () => {
  beforeEach(() => start())
  it('closes clients with 1001, is idempotent, and sends nothing afterwards', async () => {
    const c = await connect()
    await until(() => c.msgs.length > 0)
    const p1 = hub.close()
    const p2 = hub.close()
    expect(p1).toBe(p2)
    await p1
    await until(() => c.closed !== undefined)
    expect(c.closed?.code).toBe(1001)
    const n = c.msgs.length
    pub('late')
    await new Promise((r) => setTimeout(r, 120))
    expect(c.msgs.length).toBe(n)
    await hub.close()
    expect(hub.stats().clients).toBe(0)
    expect(await attempt('/ws', [PROTO, TOKEN])).toMatchObject({ status: 503 })
  })
})
