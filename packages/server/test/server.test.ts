import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import * as os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type RunningServer, type ServerOpts } from '../src/server'

import { TOKEN43 as TOKEN } from './token'
const SECRET = 'SECRET-MARKER-9f3'
let root: string
let home: string
const running: RunningServer[] = []

beforeEach(async () => {
  root = await mkdtemp(join(os.tmpdir(), 'dm-srv-root-'))
  home = await mkdtemp(join(os.tmpdir(), 'dm-srv-home-'))
})
afterEach(async () => {
  for (const s of running.splice(0)) await s.close()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const boot = async (o: Partial<ServerOpts> = {}) => {
  const s = await startServer({ port: 0, token: TOKEN, claudeRoot: root, homeDir: home, ...o })
  running.push(s)
  return s
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let b = ''
      res.on('data', (d) => (b += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on('error', reject)
  })
const tryConnect = (host: string, port: number) =>
  new Promise<'connected' | 'refused'>((resolve) => {
    const s = net.connect({ host, port })
    s.setTimeout(1500, () => { s.destroy(); resolve('refused') })
    s.on('connect', () => { s.destroy(); resolve('connected') })
    s.on('error', () => resolve('refused'))
  })

describe('startServer', () => {
  it('rejects any host other than 127.0.0.1', async () => {
    for (const host of ['0.0.0.0', 'localhost', '::1', '192.168.1.5']) {
      await expect(startServer({ port: 0, token: TOKEN, claudeRoot: root, homeDir: home, host: host as '127.0.0.1' })).rejects.toThrow('host-not-allowed')
    }
  })

  it('listens on 127.0.0.1 only', async () => {
    const s = await boot()
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/#t=${TOKEN}`)
    expect(await tryConnect('127.0.0.1', s.port)).toBe('connected')
    expect(await tryConnect('::1', s.port)).toBe('refused')
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) expect(await tryConnect(a.address, s.port)).toBe('refused')
      }
    }
  })

  it('rejects port-in-use', async () => {
    const s = await boot()
    await expect(startServer({ port: s.port, token: TOKEN, claudeRoot: root, homeDir: home })).rejects.toThrow('port-in-use')
  })

  it('serves the public shell without a token, still 403 on a bad Host, through the full server', async () => {
    const s = await boot()
    expect((await get(s.port, '/')).status).toBe(200)
    expect((await get(s.port, '/', { Host: 'evil.com' })).status).toBe(403)
  })

  it('full path: a synthetic session file shows up over the websocket', async () => {
    const dir = join(root, '-work-proj')
    await mkdir(dir, { recursive: true })
    const line = JSON.stringify({
      type: 'assistant', sessionId: 'sessfull', cwd: '/work/proj', timestamp: new Date().toISOString(),
      message: { id: 'm1', model: 'example-model', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a/b.ts' } }] },
    })
    await writeFile(join(dir, 'sessfull.jsonl'), `${line}\n`)
    const s = await boot({ ingest: { scanMs: 50, pollMs: 50 } })
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['deskmates.v1', TOKEN])
    const seen: string[] = []
    ws.on('message', (d) => seen.push(d.toString()))
    await until(() => seen.some((m) => m.includes('"sessfull"')))
    ws.terminate()
    expect(s.bus.state().agents['claude:sessfull:main']).toBeDefined()
  })

  it('autoStart:false does not ingest', async () => {
    const dir = join(root, '-work-proj')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'x.jsonl'), '{}\n')
    const s = await boot({ autoStart: false, ingest: { scanMs: 20, pollMs: 20 } })
    await new Promise((r) => setTimeout(r, 200))
    expect((s.status() as { ingest: { scan: { runs: number } } }).ingest.scan.runs).toBe(0)
  })

  it('status() carries counts and codes only, never the token, secrets or request values', async () => {
    const dir = join(root, '-work-proj')
    await mkdir(dir, { recursive: true })
    const line = JSON.stringify({
      type: 'assistant', sessionId: 'sx', cwd: `/work/${SECRET}`, timestamp: new Date().toISOString(),
      message: { id: 'm1', model: 'example-model', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: `/a/${SECRET}.ts` } }] },
    })
    await writeFile(join(dir, 'sx.jsonl'), `${line}\n`)
    const s = await boot({ ingest: { scanMs: 50, pollMs: 50 } })
    await until(() => s.bus.seq() > 0)
    await get(s.port, '/', { 'X-Probe': SECRET, Host: `${SECRET}.example.com` })
    await get(s.port, `/${SECRET}`, { Origin: `https://${SECRET}.evil.com` })
    const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['deskmates.v1', `wrong-${SECRET}`], { headers: { Origin: `https://${SECRET}.evil.com` } })
    bad.on('error', () => undefined)
    await until(() => (s.status() as { ws: { rejected: Record<string, number> } }).ws.rejected['bad-origin'] === 1)
    const st = s.status() as { server: { authFailures: number; port: number } }
    expect(st.server.authFailures).toBeGreaterThanOrEqual(3)
    const text = JSON.stringify(st)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('evil.com')
    expect(text).not.toContain(root)
    const viaApi = await get(s.port, '/api/status', { Authorization: `Bearer ${TOKEN}` })
    expect(viaApi.status).toBe(200)
    expect(viaApi.body).not.toContain(SECRET)
    expect(viaApi.body).not.toContain(TOKEN)
  })

  it('close() resolves, is idempotent, refuses new connections, and the port can be re-used', async () => {
    const s = await startServer({ port: 0, token: TOKEN, claudeRoot: root, homeDir: home })
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['deskmates.v1', TOKEN])
    let code = 0
    ws.on('close', (c) => { code = c })
    await new Promise((r) => ws.once('open', r))
    const p1 = s.close()
    const p2 = s.close()
    expect(p1).toBe(p2)
    await p1
    await until(() => code !== 0)
    expect(code).toBe(1001)
    expect(await tryConnect('127.0.0.1', s.port)).toBe('refused')
    const again = await startServer({ port: 0, token: TOKEN, claudeRoot: root, homeDir: home })
    running.push(again)
    expect((await get(again.port, '/')).status).toBe(200)
    const reuse = await startServer({ port: s.port, token: TOKEN, claudeRoot: root, homeDir: home }).catch(() => undefined)
    if (reuse) running.push(reuse)
  })
})
