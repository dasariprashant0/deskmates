import { homedir } from 'node:os'
import type http from 'node:http'
import type stream from 'node:stream'
import type { NormalizedEvent, PriceTable } from '@deskmates/core'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EventBus } from './bus'
import { redactDeep } from './redact'
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
  const homeDir = opts.homeDir ?? homedir()
  const now = opts.now ?? Date.now
  const clients = new Set<Client>()
  const st = { accepted: 0, rejected: {} as Record<string, number>, resyncs: 0, ignoredMessages: 0, droppedSlow: 0, resyncLimited: 0 }
  let closed = false
  let closing: Promise<void> | undefined

  const reject = (socket: stream.Duplex, status: 401 | 403 | 404 | 503, reason: string) => {
    st.rejected[reason] = (st.rejected[reason] ?? 0) + 1
    const body = reason
    const headers = { ...SECURITY_HEADERS(opts.getPort()), 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), Connection: 'close' }
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    try {
      socket.write(`HTTP/1.1 ${status} ${REASONS[status]}\r\n${head}\r\n\r\n${body}`, () => socket.destroy())
    } catch { /* ignore */ }
    setTimeout(() => socket.destroy(), 1000).unref()
  }

  const send = (c: Client, payload: unknown) => {
    if (closed || c.ws.readyState !== c.ws.OPEN) return
    c.ws.send(JSON.stringify(payload), (err) => { if (err) c.ws.terminate() })
  }
  const snapshot = (c: Client) => {
    const { prices, pricesAreExample } = opts.getExtras()
    send(c, { type: 'snapshot', v: 1, seq: opts.bus.seq(), state: redactDeep(opts.bus.state(), homeDir), prices, pricesAreExample })
  }

  const unsubscribe = opts.bus.subscribe((ev) => {
    for (const c of clients) {
      if (c.resyncPending) continue // the pending snapshot will cover it
      c.queue.push(ev)
      if (c.queue.length > maxQueued) { c.queue = []; c.resyncPending = true }
    }
  })

  const flush = () => {
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
        const first = events[0]
        const last = events[events.length - 1]
        if (first && last) send(c, { type: 'events', fromSeq: first.seq, toSeq: last.seq, events: redactDeep(events, homeDir) })
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
    ws.on('error', () => ws.terminate())
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
    socket.on('error', () => socket.destroy())
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
