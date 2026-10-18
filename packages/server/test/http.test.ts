import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpHandler } from '../src/http'

const TOKEN = 'tok-' + 'f'.repeat(28)
const SECRET = 'TOP-SECRET-OUTSIDE'
let tmp: string
let dir: string
let server: http.Server
let port = 0
let statusThrows = false

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string }

// raw socket request so we control Host, duplicate headers and odd paths exactly
const raw = (lines: string[], body = ''): Promise<Res> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.setTimeout(3000, () => {
      s.destroy()
      reject(new Error('timeout'))
    })
    s.on('data', (d) => (buf += d.toString('latin1')))
    s.on('error', reject)
    s.on('close', () => {
      const [head = '', ...rest] = buf.split('\r\n\r\n')
      const [first = '', ...hl] = head.split('\r\n')
      const headers: http.IncomingHttpHeaders = {}
      for (const l of hl) {
        const i = l.indexOf(':')
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim()
      }
      resolve({ status: Number(first.split(' ')[1] ?? 0), headers, body: rest.join('\r\n\r\n') })
    })
    s.write(lines.join('\r\n') + '\r\n\r\n' + body)
  })

const get = (p: string, extra: string[] = [], opts: { host?: string | null; method?: string } = {}) => {
  const host = opts.host === undefined ? `127.0.0.1:${port}` : opts.host
  return raw([
    `${opts.method ?? 'GET'} ${p} HTTP/1.1`,
    ...(host === null ? [] : [`Host: ${host}`]),
    'Connection: close',
    ...extra,
  ])
}

const securityHeaders = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
  'permissions-policy',
]
const expectHardened = (r: Res) => {
  for (const h of securityHeaders) expect(r.headers[h], h).toBeTruthy()
  expect(Object.keys(r.headers).some((k) => k.startsWith('access-control-'))).toBe(false)
  expect(r.headers.server).toBeUndefined()
  expect(r.headers['x-powered-by']).toBeUndefined()
  expect(JSON.stringify(r.headers) + r.body).not.toContain(TOKEN)
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-http-'))
  dir = path.join(tmp, 'client')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, 'blob.xyz'), 'x')
  fs.writeFileSync(path.join(tmp, 'secret'), SECRET)
  fs.symlinkSync(path.join(tmp, 'secret'), path.join(dir, 'link.js'))
  try {
    execFileSync('mkfifo', [path.join(dir, 'pipe.js')])
  } catch {
    /* mkfifo unavailable: fifo test skips itself */
  }
  server = http.createServer(
    createHttpHandler({
      token: TOKEN,
      getPort: () => port,
      clientDir: dir,
      getStatus: () => {
        if (statusThrows) throw new Error('boom')
        return { ok: true }
      },
    }),
  )
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('index route (public shell)', () => {
  it('200 placeholder without a token when index.html is missing, hardened, no inline script', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.body).toContain('not built')
    expect(r.body).not.toContain('<script')
    expectHardened(r)
  })
  it('serves index.html when present, via / and /index.html, no token needed', async () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>REAL</p>')
    try {
      for (const p of ['/', '/index.html', '/%69ndex.html']) {
        const a = await get(p)
        expect(a.status).toBe(200)
        expect(a.body).toContain('REAL')
        expect(a.headers['cache-control']).toBe('no-store')
      }
    } finally {
      fs.rmSync(path.join(dir, 'index.html'))
    }
  })
  it('HEAD returns headers and no body', async () => {
    const r = await get('/', [], { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('')
    expect(Number(r.headers['content-length'])).toBeGreaterThan(0)
  })
})

describe('method, host, origin', () => {
  it('form POST gets 405 with Allow on / and /api/status', async () => {
    for (const p of ['/', '/api/status']) {
      const r = await raw(
        [`POST ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Content-Type: application/x-www-form-urlencoded', 'Content-Length: 3', 'Connection: close'],
        'a=b',
      )
      expect(r.status).toBe(405)
      expect(r.headers.allow).toBe('GET, HEAD')
      expectHardened(r)
    }
  })
  it.each([`attacker.test:${0}`, '127.0.0.1.evil.com:0', null])('spoofed Host %j gives 403 without echo', async (h) => {
    const host = typeof h === 'string' ? h.replace(/:0$/, `:${port}`) : h
    const r = await get('/', [], { host })
    if (host === null) return expect(r.status).toBe(400) // Node's parser itself refuses HTTP/1.1 without Host
    expect(r.status).toBe(403)
    expect(r.body).not.toContain(host)
    expectHardened(r)
  })
  it('spoofed Host beats method (POST is 403)', async () => {
    const r = await get('/', [], { host: `attacker.test:${port}`, method: 'POST' })
    expect(r.status).toBe(403)
  })
  it('duplicate Host headers are 403', async () => {
    const r = await raw([`GET / HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Host: evil.test:${port}`, 'Connection: close'])
    expect(r.status).toBe(403)
  })
  it('DNS rebinding style: attacker Host with a valid token is 403', async () => {
    expect((await get('/', [], { host: `attacker.test:${port}` })).status).toBe(403)
    expect((await get('/app.js', [], { host: `attacker.test:${port}` })).status).toBe(403)
  })
  it('evil Origin is 403, absent Origin is fine', async () => {
    expect((await get('/', ['Origin: https://evil.com'])).status).toBe(403)
    expect((await get('/', ['Origin: null'])).status).toBe(403)
    expect((await get('/', [`Origin: http://localhost:${port}`])).status).toBe(200)
    expect((await get('/')).status).toBe(200)
  })
})

describe('assets and traversal', () => {
  it('asset without token is 200 with a valid Host, 403 with a bad Host', async () => {
    const r = await get('/app.js')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('javascript')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.body).toBe('console.log(1)')
    expect((await get('/app.js', [], { host: 'evil.test:1' })).status).toBe(403)
  })
  it('unknown extension is octet-stream', async () => {
    expect((await get('/blob.xyz')).headers['content-type']).toBe('application/octet-stream')
  })
  it.each([
    '/../secret',
    '/%2e%2e/secret',
    '/%2e%2E/secret',
    '/..%2fsecret',
    '/%252e%252e/secret',
    '//etc/passwd',
    '/a\\..\\b',
    '/a%5c..%5csecret',
    '/%00',
    '/app.js%00.png',
    '/..;/x',
    '/sub/../../secret',
    '/%',
  ])('traversal %s is 404 and leaks nothing', async (p) => {
    const r = await get(p)
    expect(r.status).toBe(404)
    expect(r.body).not.toContain(SECRET)
    expectHardened(r)
  })
  it('symlink out of clientDir is 404', async () => {
    const r = await get('/link.js')
    expect(r.status).toBe(404)
    expect(r.body).not.toContain(SECRET)
  })
  it('directory is 404', async () => {
    expect((await get('/sub')).status).toBe(404)
    expect((await get('/sub/')).status).toBe(404)
  })
  it('FIFO is 404 promptly', async () => {
    if (!fs.existsSync(path.join(dir, 'pipe.js'))) return
    const t = Date.now()
    expect((await get('/pipe.js')).status).toBe(404)
    expect(Date.now() - t).toBeLessThan(2000)
  })
  it('unknown path is 404 plain text', async () => {
    const r = await get('/nope.png')
    expect(r.status).toBe(404)
    expect(r.body).toBe('not found')
  })
})

describe('/api/status', () => {
  it('query token does not work', async () => expect((await get(`/api/status?t=${TOKEN}`)).status).toBe(401))
  it('bearer works and is JSON no-store', async () => {
    const r = await get('/api/status', [`Authorization: Bearer ${TOKEN}`])
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(r.body)).toEqual({ ok: true })
    expectHardened({ ...r, headers: { ...r.headers } })
  })
  it('wrong bearer is 401', async () => {
    expect((await get('/api/status', ['Authorization: Bearer nope'])).status).toBe(401)
    expect((await get('/api/status', [`Authorization: ${TOKEN}`])).status).toBe(401)
  })
  it('handler exception gives 500 error and the server keeps serving', async () => {
    statusThrows = true
    try {
      const r = await get('/api/status', [`Authorization: Bearer ${TOKEN}`])
      expect(r.status).toBe(500)
      expect(r.body).toBe('error')
      expectHardened(r)
    } finally {
      statusThrows = false
    }
    expect((await get('/app.js')).status).toBe(200)
  })
})

describe('abuse', () => {
  it('oversized header is rejected or closed and the server survives', async () => {
    const r = await get('/', [`Cookie: ${'a'.repeat(6 * 1024 * 3)}`]).catch(() => ({ status: 0 }))
    expect([0, 431]).toContain(r.status)
    expect((await get('/app.js')).status).toBe(200)
  })
})
