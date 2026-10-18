import { homedir } from 'node:os'
import type http from 'node:http'
import type stream from 'node:stream'
import type { AgentState, NormalizedEvent, OfficeState, PriceTable } from '@deskmates/core'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EventBus } from './bus'
import { makeRedactor, redactWith } from './redact'
import { SECURITY_HEADERS, checkHost, checkOrigin, checkToken } from './security'

export type WsOpts = {
  bus: EventBus
  token: string
  getPort: () => number
  getExtras: () => { prices: PriceTable; pricesAreExample: boolean }
  maxClients?: number
  maxMessageBytes?: number
  flushMs?: number
  maxBufferedBytes?: number
  pingMs?: number
  maxQueued?: number
  /** Hard cap for one serialized frame (snapshot or events batch). Client limit is 1 MiB; default leaves headroom. */
  maxFrameBytes?: number
  homeDir?: string
  now?: () => number
}
export type WsStats = {
  clients: number
  accepted: number
  rejected: Record<string, number>
  resyncs: number
  ignoredMessages: number
  droppedSlow: number
  resyncLimited: number
}
export type WsHub = {
  handleUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer): void
  close(): Promise<void>
  stats(): WsStats
}

const PROTOCOL = 'deskmates.v1'
const MAX_IGNORED = 20
const bytes = (s: string) => Buffer.byteLength(s)

const isEnded = (a: AgentState) => a.status === 'done' || a.status === 'error'
// Removal priority when a snapshot is too big: ended agents oldest first, then other agents oldest first,
// agents holding an attention request last.
const dropRank = (a: AgentState) => [a.attention ? 2 : isEnded(a) ? 0 : 1, a.endedAt ?? a.lastEventAt] as const

// Drops agents (see dropRank) until the whole frame fits `max` bytes; returns the serialized frame.
const fitSnapshot = (head: Record<string, unknown>, state: OfficeState, max: number): string => {
  const frame = (st: OfficeState) => JSON.stringify({ ...head, state: st })
  const full = frame(state)
  if (bytes(full) <= max) return full
  const rank = new Map(state.order.map((k) => [k, state.agents[k] ? dropRank(state.agents[k]) : ([3, 0] as const)]))
  const victims = [...state.order].sort((a, b) => rank.get(a)![0] - rank.get(b)![0] || rank.get(a)![1] - rank.get(b)![1])
  const sizes = new Map(state.order.map((k) => [k, bytes(JSON.stringify(state.agents[k])) + 2 * k.length + 8]))
  let over = bytes(full) - max
  const gone = new Set<string>()
  const build = () => {
    const agents: Record<string, AgentState> = {}
    for (const k of state.order) {
      const a = state.agents[k]
      if (!a || gone.has(k)) continue
      agents[k] = { ...a, children: a.children.filter((c) => !gone.has(c)) }
      if (a.parentKey !== undefined && gone.has(a.parentKey)) delete agents[k].parentKey
    }
    return frame({ ...state, agents, order: state.order.filter((k) => !gone.has(k)) })
  }
  for (let i = 0; ; ) {
    while (over > 0 && i < victims.length) { const k = victims[i++]!; gone.add(k); over -= sizes.get(k)! }
    const out = build()
    over = bytes(out) - max
    if (over <= 0 || i >= victims.length) return out // empty state is the floor; only prices can still exceed
    over += 1024 // estimate was short: take a bit more next round
  }
}
const REASONS: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }

type Client = { ws: WebSocket; queue: NormalizedEvent[]; resyncPending: boolean; alive: boolean; ignored: number; resyncAt: number[] }

export const createWsHub = (opts: WsOpts): WsHub => {
  const maxClients = opts.maxClients ?? 20
  const flushMs = opts.flushMs ?? 100
  const maxBuffered = opts.maxBufferedBytes ?? 1_048_576
  const pingMs = opts.pingMs ?? 30_000
  const maxQueued = opts.maxQueued ?? 1000
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: opts.maxMessageBytes ?? 4096,
    handleProtocols: (protocols: Set<string>) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  })
  const maxFrame = opts.maxFrameBytes ?? 900_000
  const redact = makeRedactor(opts.homeDir ?? homedir()) // compiled once
  const now = opts.now ?? Date.now
  const clients = new Set<Client>()
  const st = { accepted: 0, rejected: {} as Record<string, number>, resyncs: 0, ignoredMessages: 0, droppedSlow: 0, resyncLimited: 0 }
  let closed = false
  let closing: Promise<void> | undefined

  const count = (reason: string) => { st.rejected[reason] = (st.rejected[reason] ?? 0) + 1 }
  const reject = (socket: stream.Duplex, status: 401 | 403 | 404 | 503, reason: string) => {
    count(reason)
    const body = reason
    const headers = { ...SECURITY_HEADERS(opts.getPort()), 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), Connection: 'close' }
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    try {
      socket.write(`HTTP/1.1 ${status} ${REASONS[status]}\r\n${head}\r\n\r\n${body}`, () => socket.destroy())
    } catch { /* ignore */ }
    setTimeout(() => socket.destroy(), 1000).unref()
  }

  const sendRaw = (c: Client, text: string) => {
    if (closed || c.ws.readyState !== c.ws.OPEN) return
    c.ws.send(text, (err) => { if (err) { count('socket-error'); c.ws.terminate() } })
  }
  const snapshot = (c: Client) => {
    const { prices, pricesAreExample } = opts.getExtras()
    const head = { type: 'snapshot', v: 1, seq: opts.bus.seq(), prices, pricesAreExample }
    sendRaw(c, fitSnapshot(head, redactWith(opts.bus.state(), redact), maxFrame))
  }
  // Serialized event frames, shared by every client whose batch is the same; cleared per flush.
  const eventFrames = (events: NormalizedEvent[], cache: Map<string, string[]>): string[] => {
    const first = events[0]!
    const last = events[events.length - 1]!
    const key = `${first.seq}:${last.seq}:${events.length}`
    let out = cache.get(key)
    if (!out) {
      const red = redactWith(events, redact)
      const enc = (from: number, to: number): string[] => {
        const part = red.slice(from, to)
        const str = JSON.stringify({ type: 'events', fromSeq: part[0]!.seq, toSeq: part[part.length - 1]!.seq, events: part })
        if (part.length === 1 || bytes(str) <= maxFrame) return [str] // a single event is capped at parse time
        const mid = from + Math.ceil(part.length / 2)
        return [...enc(from, mid), ...enc(mid, to)]
      }
      out = enc(0, red.length)
      cache.set(key, out)
    }
    return out
  }

  const unsubscribe = opts.bus.subscribe((ev) => {
    for (const c of clients) {
      if (c.resyncPending) continue // the pending snapshot will cover it
      c.queue.push(ev)
      if (c.queue.length > maxQueued) { c.queue = []; c.resyncPending = true }
    }
  })

  const flush = () => {
    const cache = new Map<string, string[]>()
    for (const c of [...clients]) {
      if (c.ws.bufferedAmount > maxBuffered) { st.droppedSlow++; c.ws.terminate(); continue }
      if (c.resyncPending) {
        c.resyncPending = false
        c.queue = []
        st.resyncs++
        snapshot(c)
      } else if (c.queue.length > 0) {
        const events = c.queue
        c.queue = []
        for (const frame of eventFrames(events, cache)) sendRaw(c, frame)
      }
    }
  }
  const flushTimer = setInterval(flush, flushMs)
  flushTimer.unref()

  const pingTimer = setInterval(() => {
    for (const c of [...clients]) {
      if (!c.alive) { c.ws.terminate(); continue }
      c.alive = false
      try { c.ws.ping() } catch { c.ws.terminate() }
    }
  }, pingMs)
  pingTimer.unref()

  const onMessage = (c: Client, data: Buffer, isBinary: boolean) => {
    const policy = () => c.ws.close(1008, 'policy')
    if (isBinary) return policy()
    let msg: unknown
    try { msg = JSON.parse(data.toString('utf8')) } catch { return policy() }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return policy()
    const type = (msg as { type?: unknown }).type
    if (typeof type !== 'string') return policy()
    if (type === 'resync') {
      const t = now()
      c.resyncAt = c.resyncAt.filter((x) => t - x < 1000)
      c.resyncAt.push(t)
      if (c.resyncAt.length > 5) { if (c.resyncAt.length === 6) st.resyncLimited++; return policy() }
      st.resyncs++
      c.queue = []
      c.resyncPending = false
      snapshot(c)
      return
    }
    st.ignoredMessages++
    if (++c.ignored >= MAX_IGNORED) policy()
  }

  const accept = (ws: WebSocket) => {
    ws.on('error', () => { count('socket-error'); ws.terminate() })
    const c: Client = { ws, queue: [], resyncPending: false, alive: true, ignored: 0, resyncAt: [] }
    clients.add(c)
    st.accepted++
    ws.on('pong', () => { c.alive = true })
    ws.on('close', () => { clients.delete(c) })
    ws.on('message', (data, isBinary) => {
      if (closed) return
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
      onMessage(c, buf, isBinary)
    })
    snapshot(c) // always first, before any event
  }

  const handleUpgrade: WsHub['handleUpgrade'] = (req, socket, head) => {
    socket.on('error', () => { count('socket-error'); socket.destroy() })
    if (closed) return reject(socket, 503, 'closed')
    if (req.url !== '/ws') return reject(socket, 404, 'bad-path')
    const port = opts.getPort()
    let hosts = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'host') hosts++
    if (hosts !== 1 || !checkHost(req.headers.host, port).ok) return reject(socket, 403, 'bad-host')
    if (!checkOrigin(req.headers.origin, port).ok) return reject(socket, 403, 'bad-origin')
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    const token = offered[0] === PROTOCOL && offered.length === 2 ? offered[1] : undefined
    if (!checkToken(token, opts.token).ok) return reject(socket, 401, 'bad-token')
    if (clients.size >= maxClients) return reject(socket, 503, 'full')
    try {
      wss.handleUpgrade(req, socket, head, accept)
    } catch {
      count('upgrade-failed')
      socket.destroy()
    }
  }

  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true
      clearInterval(flushTimer)
      clearInterval(pingTimer)
      unsubscribe()
      const all = [...clients]
      const done = Promise.all(all.map((c) => new Promise<void>((res) => {
        if (c.ws.readyState === c.ws.CLOSED) return res()
        c.ws.once('close', () => res())
        const t = setTimeout(() => c.ws.terminate(), 500)
        t.unref()
        c.ws.close(1001, 'going away')
      })))
      await done
      await new Promise<void>((res) => wss.close(() => res()))
    })()
    return closing
  }

  return {
    handleUpgrade,
    close,
    stats: () => ({ clients: clients.size, accepted: st.accepted, rejected: { ...st.rejected }, resyncs: st.resyncs, ignoredMessages: st.ignoredMessages, droppedSlow: st.droppedSlow, resyncLimited: st.resyncLimited }),
  }
}
