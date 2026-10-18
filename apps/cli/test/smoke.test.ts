import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..')
type Sock = { on(e: 'message', cb: (d: unknown) => void): void; on(e: 'error', cb: (e: Error) => void): void; close(): void; terminate(): void }
const WS = createRequire(join(cli, '../../packages/server/package.json'))('ws') as { WebSocket: new (url: string, protocols: string[]) => Sock }
let tmp = ''
const kids: ChildProcess[] = []

const launch = (args: string[]) => {
  const child = spawn(process.execPath, [join(cli, 'dist/deskmates.js'), '--no-open', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(child)
  let out = ''
  let err = ''
  child.stdout!.on('data', (d) => { out += d })
  child.stderr!.on('data', (d) => { err += d })
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
  const url = new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error('no url printed')), 10_000)
    const poll = setInterval(() => {
      const m = /http:\/\/127\.0\.0\.1:\d+\/#t=\S+/.exec(out)
      if (m) { clearTimeout(t); clearInterval(poll); res(m[0]) }
    }, 50)
    void exited.then(() => { clearTimeout(t); clearInterval(poll); rej(new Error('exited early')) })
  })
  void url.catch(() => undefined) // callers that expect an early exit never await url
  return { child, url, exited, err: () => err, out: () => out }
}

const rawGet = (port: number, host: string) => new Promise<string>((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
  let buf = ''
  s.on('data', (d) => { buf += d })
  s.on('end', () => resolve(buf))
  s.on('error', reject)
})

beforeAll(() => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: cli, stdio: 'pipe' })
  tmp = mkdtempSync(join(tmpdir(), 'deskmates-smoke-'))
  const dir = join(tmp, '-tmp-proj')
  mkdirSync(dir)
  writeFileSync(join(dir, 's1.jsonl'), JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n')
}, 60_000)

afterAll(() => {
  for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL')
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

test('launch, host check, websocket snapshot, port clash, SIGINT', async () => {
  const a = launch(['--port', '0', '--projects-dir', tmp])
  const url = await a.url
  const u = new URL(url)
  const port = Number(u.port)
  const token = new URLSearchParams(u.hash.slice(1)).get('t')!
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

  expect(await rawGet(port, 'evil.test')).toMatch(/^HTTP\/1\.1 403/)
  const ok = await fetch(`http://127.0.0.1:${port}/`)
  expect(ok.status).toBe(200)

  const first = await new Promise<string>((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', token])
    const t = setTimeout(() => { ws.terminate(); reject(new Error('no ws message')) }, 5000)
    ws.on('message', (d) => { clearTimeout(t); ws.close(); resolve(String(d)) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
  expect(JSON.parse(first)).toMatchObject({ type: 'snapshot' })

  const b = launch(['--port', String(port), '--projects-dir', tmp])
  expect(await b.exited).toBe(1)
  expect(b.err()).toContain(`Port ${port} is already in use. Try --port 0 for a free port.`)

  const t0 = Date.now()
  a.child.kill('SIGINT')
  expect(await a.exited).toBe(0)
  expect(Date.now() - t0).toBeLessThan(3000)
}, 40_000)

test('missing or non-directory --projects-dir does not crash and leaks no token', async () => {
  for (const p of [join(tmp, 'does-not-exist'), join(tmp, '-tmp-proj', 's1.jsonl')]) {
    const a = launch(['--port', '0', '--projects-dir', p])
    const url = await a.url
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t')!
    expect(a.out().replace(url, '')).not.toContain(token)
    expect(a.err()).not.toContain(token)
    expect((await fetch(`http://127.0.0.1:${new URL(url).port}/`)).status).toBe(200)
    a.child.kill('SIGINT')
    expect(await a.exited).toBe(0)
    expect(a.err()).toBe('')
  }
}, 30_000)
