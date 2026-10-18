import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpHandler } from '../src/http'
import { startServer } from '../src/server'
import { TOKEN43 as TOKEN } from './token'

let server: http.Server
let port = 0
let tmp: string

const raw = (lines: string[]): Promise<{ status: number; head: string; body: string }> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.on('data', (d) => (buf += d.toString('latin1')))
    s.on('error', reject)
    s.on('close', () => {
      const [head = '', ...rest] = buf.split('\r\n\r\n')
      resolve({ status: Number(head.split(' ')[1] ?? 0), head, body: rest.join('\r\n\r\n') })
    })
    s.write(lines.join('\r\n') + '\r\n\r\n')
  })
const get = (p: string, extra: string[] = [], host = `127.0.0.1:${port}`) =>
  raw([`GET ${p} HTTP/1.1`, `Host: ${host}`, 'Connection: close', ...extra])

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fp-'))
  server = http.createServer(createHttpHandler({ token: TOKEN, getPort: () => port, clientDir: tmp, getStatus: () => ({ ok: true }) }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('public shell', () => {
  it('/, /index.html, /INDEX.HTML, /Index.Html behave identically (200 shell, no token)', async () => {
    const rs = await Promise.all(['/', '/index.html', '/INDEX.HTML', '/Index.Html'].map((p) => get(p)))
    for (const r of rs) {
      expect(r.status).toBe(200)
      expect(r.body).toBe(rs[0]?.body)
    }
  })
  it('all variants are 403 on a bad Host', async () => {
    for (const p of ['/', '/index.html', '/INDEX.HTML', '/Index.Html']) expect((await get(p, [], 'evil.test:1')).status).toBe(403)
  })
  it('a query ?t= has no special effect (right, wrong, or none)', async () => {
    const base = await get('/')
    for (const q of [`/?t=${TOKEN}`, '/?t=nope', '/?t=', '/index.html?t=x']) {
      const r = await get(q)
      expect(r.status).toBe(200)
      expect(r.body).toBe(base.body)
    }
  })
  it('the token appears in no response header or body', async () => {
    for (const p of [`/?t=${TOKEN}`, '/', '/nope.js']) {
      const r = await get(p, [`Authorization: Bearer ${TOKEN}`])
      expect(r.head + r.body).not.toContain(TOKEN)
    }
  })
  it('/api/status still needs the Bearer token only', async () => {
    expect((await get(`/api/status?t=${TOKEN}`)).status).toBe(401)
    expect((await get('/api/status', [`Authorization: Bearer ${TOKEN}`])).status).toBe(200)
  })
})

describe('Sec-Fetch-Site', () => {
  it.each(['/', '/api/status', '/app.js', '/nope'])('cross-site is 403 forbidden on %s', async (p) => {
    const r = await get(p, ['Sec-Fetch-Site: cross-site', `Authorization: Bearer ${TOKEN}`])
    expect(r.status).toBe(403)
    expect(r.body).toBe('forbidden')
  })
  it('no-cors script/style/image from cross-site is 403', async () => {
    for (const dest of ['script', 'style', 'image']) {
      expect((await get('/', ['Sec-Fetch-Site: cross-site', 'Sec-Fetch-Mode: no-cors', `Sec-Fetch-Dest: ${dest}`])).status).toBe(403)
    }
  })
  it.each(['same-origin', 'same-site', 'none'])('%s is allowed', async (v) => {
    expect((await get('/', [`Sec-Fetch-Site: ${v}`])).status).toBe(200)
  })
  it('a missing header is allowed', async () => expect((await get('/')).status).toBe(200))
})

describe('startServer token strength and url', () => {
  const base = { port: 0, claudeRoot: '/nonexistent-dm-root', autoStart: false }
  it('rejects short tokens', async () => {
    await expect(startServer({ ...base, token: 'a'.repeat(31) })).rejects.toThrow('token-too-short')
    await expect(startServer({ ...base, token: '' })).rejects.toThrow('token-too-short')
  })
  it.each(['a'.repeat(31) + '.', 'a'.repeat(40) + ' b', 'a'.repeat(40) + ',', 'a'.repeat(40) + '+', 'a'.repeat(40) + '/', 'a'.repeat(40) + '=', 'a'.repeat(40) + '\u00e9'])(
    'rejects invalid chars %j',
    async (t) => {
      await expect(startServer({ ...base, token: t })).rejects.toThrow('token-invalid-chars')
    },
  )
  it('accepts a valid 43-char token and puts it in the URL fragment', async () => {
    const s = await startServer({ ...base, token: TOKEN, homeDir: tmp })
    try {
      expect(s.url).toBe(`http://127.0.0.1:${s.port}/#t=${TOKEN}`)
      expect(s.url).not.toContain('?')
    } finally {
      await s.close()
    }
  })
})
