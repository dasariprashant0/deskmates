import { constants as fsc } from 'node:fs'
import * as fs from 'node:fs/promises'
import type http from 'node:http'
import * as path from 'node:path'
import { SECURITY_HEADERS, checkFetchSite, checkHost, checkOrigin, checkToken } from './security'

export type HttpOpts = { token: string; getPort: () => number; clientDir?: string; getStatus: () => unknown }

const MAX_BYTES = 5 * 1024 * 1024

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

const PLACEHOLDER =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>deskmates</title></head><body><p>The deskmates client is not built yet.</p></body></html>'

type Reply = (status: number, type: string, body: string | Buffer, extra?: Record<string, string>) => void

// Decode once and refuse anything that could leave the client dir. Returns undefined for "not found".
const cleanPath = (rawUrl: string | undefined): string | undefined => {
  if (rawUrl === undefined || !rawUrl.startsWith('/')) return undefined
  const rawPath = rawUrl.split(/[?#]/, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined
  if (decoded === '/') return decoded
  for (const seg of decoded.slice(1).split('/')) {
    if (seg === '' || seg.startsWith('.')) return undefined // empty, '.', '..', dotfiles
  }
  return decoded
}

const readInside = async (root: string, rel: string): Promise<Buffer | undefined> => {
  let realRoot: string
  let real: string
  try {
    realRoot = await fs.realpath(root)
    real = await fs.realpath(path.join(realRoot, rel))
  } catch {
    return undefined
  }
  if (!real.startsWith(realRoot + path.sep)) return undefined
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(real, fsc.O_RDONLY | fsc.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_BYTES) return undefined
    return await fh.readFile()
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export const createHttpHandler = (opts: HttpOpts) => {
  const route = async (req: http.IncomingMessage, send: Reply, port: number): Promise<void> => {
    const text = (status: number, body: string, extra?: Record<string, string>) =>
      send(status, 'text/plain; charset=utf-8', body, extra)
    let hosts = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'host') hosts++
    if (hosts !== 1 || !checkHost(req.headers.host, port).ok) return text(403, 'forbidden')
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed', { Allow: 'GET, HEAD' })
    if (!checkOrigin(req.headers.origin, port).ok) return text(403, 'forbidden')
    if (!checkFetchSite(req.headers['sec-fetch-site'] as string | undefined).ok) return text(403, 'forbidden')

    const p = cleanPath(req.url)
    if (p === undefined) return text(404, 'not found')

    if (p === '/api/status') {
      const auth = req.headers.authorization ?? ''
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : undefined
      if (!checkToken(given, opts.token).ok) return text(401, 'unauthorized')
      return send(200, 'application/json', JSON.stringify(opts.getStatus()), { 'Cache-Control': 'no-store' })
    }

    // The shell holds no data; everything sensitive flows over the token-gated WebSocket.
    if (p === '/' || p.toLowerCase() === '/index.html') {
      const file = opts.clientDir === undefined ? undefined : await readInside(opts.clientDir, 'index.html')
      return send(200, TYPES['.html'] ?? 'text/html', file ?? PLACEHOLDER, { 'Cache-Control': 'no-store' })
    }

    const file = opts.clientDir === undefined ? undefined : await readInside(opts.clientDir, p.slice(1))
    if (file === undefined) return text(404, 'not found')
    return send(200, TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream', file)
  }

  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const fail = () => {
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        }
        res.end('error')
      } catch {
        res.destroy()
      }
    }
    try {
      const port = opts.getPort()
      for (const [k, v] of Object.entries(SECURITY_HEADERS(port))) res.setHeader(k, v)
      res.removeHeader('X-Powered-By')
      const send: Reply = (status, type, body, extra) => {
        res.statusCode = status
        res.setHeader('Content-Type', type)
        res.setHeader('Content-Length', Buffer.byteLength(body))
        for (const [k, v] of Object.entries(extra ?? {})) res.setHeader(k, v)
        res.end(req.method === 'HEAD' ? undefined : body)
      }
      route(req, send, port).catch(fail)
    } catch {
      fail()
    }
  }
}
