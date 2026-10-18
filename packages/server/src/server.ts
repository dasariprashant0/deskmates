import http from 'node:http'
import * as os from 'node:os'
import type { EventBus as Bus } from './bus'
import { EventBus } from './bus'
import { createHttpHandler } from './http'
import { createIngest, type IngestOpts } from './ingest'
import { loadPrices } from './prices'
import { startTicker } from './ticker'
import { tokenProblem } from './security'
import { createWsHub } from './ws'

export type ServerOpts = {
  port: number
  host?: '127.0.0.1'
  token: string
  claudeRoot: string
  clientDir?: string
  homeDir?: string
  now?: () => number
  ingest?: Partial<Omit<IngestOpts, 'root' | 'bus'>>
  autoStart?: boolean
}
export type RunningServer = { port: number; url: string; bus: Bus; close(): Promise<void>; status(): unknown }

export const startServer = async (opts: ServerOpts): Promise<RunningServer> => {
  // v0.1 never binds beyond loopback; the type allows only this value, the check guards casts and JS callers.
  if ((opts.host ?? '127.0.0.1') !== '127.0.0.1') throw new Error('host-not-allowed')
  const problem = tokenProblem(opts.token)
  if (problem !== undefined) throw new Error(problem)
  const now = opts.now ?? Date.now
  const bus = new EventBus()
  const ingest = createIngest({ root: opts.claudeRoot, bus, now, ...opts.ingest })
  const loaded = await loadPrices({ homeDir: opts.homeDir ?? os.homedir() })
  const auto = opts.autoStart ?? true
  let port = opts.port
  let httpAuthFailures = 0
  let httpConnections = 0
  const startedAt = now()

  const hub = createWsHub({ bus, token: opts.token, homeDir: opts.homeDir ?? os.homedir(), getPort: () => port, getExtras: () => ({ prices: loaded.prices, pricesSource: loaded.source, pricesAsOf: loaded.asOf }) })
  let ticker: ReturnType<typeof startTicker> | undefined
  const status = () => ({
    server: { port, startedAt, httpConnections, authFailures: httpAuthFailures + (hub.stats().rejected['bad-host'] ?? 0) + (hub.stats().rejected['bad-origin'] ?? 0) + (hub.stats().rejected['bad-token'] ?? 0) },
    ws: hub.stats(),
    ingest: ingest.status(),
    prices: { isExample: loaded.isExample, pricesSource: loaded.source, ...(loaded.reason !== undefined && { reason: loaded.reason }) },
    ticker: ticker?.stats() ?? { ticks: 0, errors: {} },
  })

  const handler = createHttpHandler({ token: opts.token, getPort: () => port, ...(opts.clientDir !== undefined && { clientDir: opts.clientDir }), getStatus: status })
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.on('finish', () => { if (res.statusCode === 401 || res.statusCode === 403) httpAuthFailures++ })
    handler(req, res)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 100
  server.on('connection', (s) => { httpConnections++; s.on('close', () => { httpConnections-- }) })
  server.on('upgrade', hub.handleUpgrade)
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (e) {
    await hub.close()
    throw new Error((e as { code?: unknown } | null)?.code === 'EADDRINUSE' ? 'port-in-use' : 'listen-failed')
  }
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : opts.port
  server.on('error', () => undefined) // post-listen errors must not crash the process

  if (auto) {
    ingest.start()
    ticker = startTicker({ bus, now })
  }

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      ticker?.stop()
      const down = new Promise<void>((res) => server.close(() => res()))
      await hub.close()
      server.closeAllConnections()
      await down
      await ingest.stop()
    })()
    return closing
  }

  return { port, url: `http://127.0.0.1:${port}/#t=${opts.token}`, bus, close, status }
}
