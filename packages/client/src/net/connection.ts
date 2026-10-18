import { createMirror, type Mirror } from './mirror'
import { encodeResync, parseServerMessage, PROTOCOL } from './protocol'

export type Status = 'connecting' | 'live' | 'reconnecting' | 'offline'
type Handler<E> = { bivarianceHack(ev: E): void }['bivarianceHack']
export type WebSocketLike = {
  onmessage: Handler<{ data: unknown }> | null
  onclose: Handler<{ code: number }> | null
  onerror: Handler<unknown> | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type ConnectionOpts = {
  url: string
  token: string
  WebSocketImpl: new (url: string, protocols?: string | string[]) => WebSocketLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  now: () => number
  onStatus(s: Status): void
  onChange(): void
  random?: () => number
}
export type Connection = { start(): void; stop(): void; resync(): void; mirror: Mirror }

const BASE_MS = 1000
const MAX_MS = 30_000
const JITTER = 0.2
const OFFLINE_MS = 60_000
const RESYNC_WINDOW_MS = 1000
const MAX_INVALID_RUN = 50

export function createConnection(opts: ConnectionOpts): Connection {
  const mirror = createMirror()
  const setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>))
  const random = opts.random ?? Math.random

  let ws: WebSocketLike | undefined
  let status: Status | undefined
  let started = false
  let stopped = false
  let attempt = 0
  let invalidRun = 0
  let lastResyncAt: number | undefined
  let reconnectTimer: unknown
  let resyncTimer: unknown
  let hasReconnectTimer = false
  let hasResyncTimer = false

  const setStatus = (s: Status) => {
    if (s === status) return
    status = s
    opts.onStatus(s)
  }

  const sendResync = () => {
    lastResyncAt = opts.now()
    try { ws?.send(encodeResync()) } catch { /* socket is closing; the close handler reconnects */ }
  }
  const requestResync = () => {
    if (stopped || !ws || hasResyncTimer) return
    const wait = lastResyncAt === undefined ? 0 : lastResyncAt + RESYNC_WINDOW_MS - opts.now()
    if (wait <= 0) return sendResync()
    hasResyncTimer = true
    resyncTimer = setT(() => { hasResyncTimer = false; if (!stopped) sendResync() }, wait)
  }
  const cancelResync = () => {
    if (hasResyncTimer) clearT(resyncTimer)
    hasResyncTimer = false
  }

  const detach = () => {
    const s = ws
    ws = undefined
    cancelResync()
    if (!s) return
    s.onmessage = null
    s.onclose = null
    s.onerror = null
    try { s.close() } catch { /* already closed */ }
  }

  const scheduleReconnect = (code?: number) => {
    if (stopped) return
    detach()
    let delay: number
    if (code === 1008 || code === 1009) {
      setStatus('offline')
      delay = OFFLINE_MS
      attempt = 6 // after the pause, further failures retry at the max backoff
    } else {
      setStatus('reconnecting')
      const base = Math.min(BASE_MS * 2 ** attempt, MAX_MS)
      delay = base * (1 + (random() * 2 - 1) * JITTER)
      attempt++
    }
    if (hasReconnectTimer) clearT(reconnectTimer)
    hasReconnectTimer = true
    reconnectTimer = setT(() => { hasReconnectTimer = false; connect() }, delay)
  }

  const onFrame = (data: unknown) => {
    const msg = parseServerMessage(data)
    if (msg.type === 'invalid') {
      mirror.noteInvalid()
      if (++invalidRun >= MAX_INVALID_RUN) { invalidRun = 0; scheduleReconnect() }
      return
    }
    invalidRun = 0
    if (msg.type === 'snapshot') {
      mirror.applySnapshot(msg)
      cancelResync() // the snapshot answers any pending gap
      attempt = 0
      setStatus('live')
      opts.onChange()
      return
    }
    const r = mirror.applyEvents(msg)
    if (r === 'ok') opts.onChange()
    else if (r === 'gap') requestResync()
  }

  function connect() {
    if (stopped) return
    // Token goes only in the subprotocol offer (never the URL).
    const sock = new opts.WebSocketImpl(opts.url, [PROTOCOL, opts.token])
    ws = sock
    invalidRun = 0
    sock.onmessage = (ev) => { if (ws === sock && !stopped) onFrame(ev.data) }
    sock.onclose = (ev) => { if (ws === sock) scheduleReconnect(ev.code) }
    sock.onerror = () => { if (ws === sock) scheduleReconnect() }
  }

  return {
    mirror,
    start() {
      if (started) return
      started = true
      setStatus('connecting')
      connect()
    },
    stop() {
      stopped = true
      if (hasReconnectTimer) clearT(reconnectTimer)
      hasReconnectTimer = false
      detach()
    },
    resync: requestResync,
  }
}
