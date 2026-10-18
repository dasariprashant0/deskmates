#!/usr/bin/env node
// Live attack harness: spawns the built CLI against a synthetic fixture and fires about 237 attacks at it.
// Usage: node scripts/attack.mjs   (build first: (cd packages/client && node build.mjs) && (cd apps/cli && node build.mjs))
// Expectations come from docs/SECURITY.md and packages/server/src/{security,http,ws,server}.ts.
// Uses only node built-ins plus `ws` (resolved from packages/server). Synthetic data only. Exits nonzero on any FAIL.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages/server/package.json'))
const { WebSocket } = require('ws')
const HOME = os.homedir()
const MARKER = 'TRANSCRIPT-MARKER-9f3a7c'

// ---------- fixture ----------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dm-attack-'))
const projDir = path.join(tmp, '-work-proj')
mkdirSync(projDir, { recursive: true })
const iso = (ms) => new Date(ms).toISOString()
const t0 = Date.now()
writeFileSync(path.join(projDir, 'sess.jsonl'), [
  { type: 'assistant', sessionId: 'sess', cwd: `${HOME}/attack-fixture`, timestamp: iso(t0 - 2000), message: { id: 'm1', model: 'example-model', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a/b.ts' } }] } },
  { type: 'user', sessionId: 'sess', cwd: `${HOME}/attack-fixture`, timestamp: iso(t0 - 1000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: MARKER, is_error: false }] } },
].map((o) => JSON.stringify(o) + '\n').join(''))

// ---------- spawn CLI ----------
let child
let stdout = ''
let stderr = ''
let PORT = 0
let TOKEN = ''
const cleanup = () => { try { child?.kill('SIGKILL') } catch {} ; try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const start = () => new Promise((resolve, reject) => {
  child = spawn(process.execPath, [path.join(ROOT, 'apps/cli/dist/deskmates.js'), '--no-open', '--port', '0', '--projects-dir', tmp], { stdio: ['ignore', 'pipe', 'pipe'] })
  const timer = setTimeout(() => reject(new Error('CLI did not print a launch URL in 10s')), 10000)
  child.stderr.on('data', (d) => { stderr += d })
  child.on('exit', (c) => reject(new Error(`CLI exited early (${c}): ${stderr}`)))
  child.stdout.on('data', (d) => {
    stdout += d
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([A-Za-z0-9_-]+)/.exec(stdout)
    if (m) { clearTimeout(timer); PORT = Number(m[1]); TOKEN = m[2]; child.removeAllListeners('exit'); resolve() }
  })
})

// ---------- raw HTTP helpers ----------
const seen = [] // every byte received from the server, for the global leak scan
const raw = (data, { wait = 4000 } = {}) => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1')
  const chunks = []
  let done = false
  const finish = (closed) => {
    if (done) return
    done = true
    clearTimeout(t)
    s.destroy()
    const buf = Buffer.concat(chunks)
    seen.push(buf)
    const text = buf.toString('latin1')
    const i = text.indexOf('\r\n\r\n')
    const head = i < 0 ? text : text.slice(0, i)
    const lines = head.split('\r\n')
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1]
    const headers = {}
    for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) (headers[l.slice(0, k).toLowerCase()] ??= []).push(l.slice(k + 1).trim()) }
    resolve({ status: status ? Number(status) : undefined, headers, body: i < 0 ? '' : text.slice(i + 4), text, count: (text.match(/HTTP\/1\.[01] \d{3} [A-Z]/g) ?? []).length, closed })
  }
  const t = setTimeout(() => finish(false), wait)
  s.on('data', (d) => chunks.push(d))
  s.on('close', () => finish(true))
  s.on('error', () => finish(true))
  s.on('connect', () => { if (data) s.write(data) })
})

const HOSTOK = () => `127.0.0.1:${PORT}`
// Build a request. `host` undefined = good host; null = omit; array = multiple Host headers.
const req = (p = '/', { method = 'GET', host, headers = [], body = '', version = '1.1' } = {}) => {
  const hs = host === null ? [] : (Array.isArray(host) ? host : [host ?? HOSTOK()]).map((h) => `Host: ${h}`)
  return raw(`${method} ${p} HTTP/${version}\r\n${[...hs, 'Connection: close', ...headers].join('\r\n')}\r\n\r\n${body}`)
}
const bearer = (t = TOKEN) => [`Authorization: Bearer ${t}`]

// WebSocket upgrade handshake, raw. Returns the same shape as req().
const wsKey = 'dGhlIHNhbXBsZSBub25jZQ=='
const upgrade = (p = '/ws', { host, origin, protocols, headers = [], key = true, version = '13' } = {}) => {
  const hs = host === null ? [] : (Array.isArray(host) ? host : [host ?? HOSTOK()]).map((h) => `Host: ${h}`)
  const lines = [...hs, 'Upgrade: websocket', 'Connection: Upgrade', ...(key ? [`Sec-WebSocket-Key: ${wsKey}`] : []), `Sec-WebSocket-Version: ${version}`]
  if (origin !== undefined) lines.push(`Origin: ${origin}`)
  if (protocols !== undefined) lines.push(`Sec-WebSocket-Protocol: ${protocols}`)
  return raw(`GET ${p} HTTP/1.1\r\n${[...lines, ...headers].join('\r\n')}\r\n\r\n`, { wait: 1500 })
}

// ws client; resolves with {open, code, messages, ws}
const wsConnect = (opts = {}) => new Promise((resolve) => {
  const proto = opts.protocols ?? ['deskmates.v1', TOKEN]
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, proto, { headers: { Host: HOSTOK(), ...(opts.origin ? { Origin: opts.origin } : {}) } })
  const r = { ws, messages: [], open: false, code: undefined, status: undefined, protocol: undefined }
  ws.on('message', (d, bin) => { seen.push(Buffer.from(d)); r.messages.push({ text: d.toString(), bin }) })
  ws.on('open', () => { r.open = true; r.protocol = ws.protocol; resolve(r) })
  ws.on('unexpected-response', (_q, res) => { r.status = res.statusCode; res.resume(); resolve(r) })
  ws.on('close', (c) => { r.code = c; resolve(r) })
  ws.on('error', () => {})
  setTimeout(() => resolve(r), 3000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitClose = (r, ms = 2500) => new Promise((resolve) => {
  if (r.ws.readyState === WebSocket.CLOSED) return resolve(r.code)
  const t = setTimeout(() => resolve('still-open'), ms)
  r.ws.once('close', (c) => { clearTimeout(t); resolve(c) })
})

// Start before registering attacks so PORT and TOKEN are known when expectations are built.
await start()
console.log(`CLI up on 127.0.0.1:${PORT}, fixture ${tmp}\n`)

// ---------- attack registry ----------
const attacks = []
const atk = (cat, name, expect, fn) => attacks.push({ cat, name, expect, fn })
const rejected = (r) => r.status === undefined || r.status >= 400 // 4xx/5xx or connection closed with no response
const is = (r, ...codes) => codes.includes(r.status)
const noSuccess = (r) => !(r.status >= 200 && r.status < 400)
const show = (r) => (r.status ?? (r.closed ? 'closed' : 'no-response')) + (r.count > 1 ? ` (${r.count} responses)` : '')

// Status-style attack: expected description + predicate over a raw response.
const http = (cat, name, expectDesc, call, pred) => atk(cat, name, expectDesc, async () => { const r = await call(); return { ok: pred(r), actual: show(r) } })
const want = (cat, name, call, ...codes) => http(cat, name, codes.join('/'), call, (r) => is(r, ...codes))
const deny = (cat, name, call) => http(cat, name, '4xx or closed, no 2xx', call, (r) => rejected(r) && noSuccess(r))

// ===== Host =====
const H = 'Host'
want(H, 'control: Host 127.0.0.1:PORT', () => req('/'), 200)
want(H, 'control: Host localhost:PORT', () => req('/', { host: `localhost:${PORT}` }), 200)
atk(H, 'missing Host (HTTP/1.1)', '400 or 403', async () => { const r = await req('/', { host: null }); return { ok: is(r, 400, 403), actual: show(r) } })
atk(H, 'missing Host (HTTP/1.0)', '400 or 403', async () => { const r = await req('/', { host: null, version: '1.0' }); return { ok: is(r, 400, 403), actual: show(r) } })
for (const [n, h] of [
  ['evil.com', () => 'evil.com'], ['evil.com:PORT', () => `evil.com:${PORT}`], ['localhost without port', () => 'localhost'],
  ['127.0.0.1 without port', () => '127.0.0.1'], ['localhost wrong port', () => `localhost:${PORT + 1}`], ['127.0.0.1 port 80', () => '127.0.0.1:80'],
  ['0.0.0.0:PORT', () => `0.0.0.0:${PORT}`], ['[::1]:PORT', () => `[::1]:${PORT}`], ['127.1:PORT (IP shorthand)', () => `127.1:${PORT}`],
  ['2130706433:PORT (decimal IP)', () => `2130706433:${PORT}`], ['0x7f.0.0.1:PORT (hex IP)', () => `0x7f.0.0.1:${PORT}`],
  ['017700000001:PORT (octal IP)', () => `017700000001:${PORT}`], ['localhost.:PORT (trailing dot)', () => `localhost.:${PORT}`],
  ['127.0.0.1.:PORT (trailing dot)', () => `127.0.0.1.:${PORT}`], ['127.0.0.1.nip.io:PORT (rebind name)', () => `127.0.0.1.nip.io:${PORT}`],
  ['localhost.evil.com:PORT', () => `localhost.evil.com:${PORT}`], ['evil.com#@127.0.0.1:PORT', () => `evil.com#@127.0.0.1:${PORT}`],
  ['user@127.0.0.1:PORT (userinfo)', () => `user@127.0.0.1:${PORT}`], ['127.0.0.1:PORT:PORT', () => `127.0.0.1:${PORT}:${PORT}`],
  ['127.0.0.1:0PORT (leading zero)', () => `127.0.0.1:0${PORT}`], ['empty Host value', () => ''],
]) deny(H, `bad Host ${n}`, () => req('/', { host: h() }))
want(H, 'Host LOCALHOST:PORT (uppercase, case-insensitive allowed)', () => req('/', { host: `LOCALHOST:${PORT}` }), 200)
deny(H, 'duplicate Host (good, good)', () => req('/', { host: [HOSTOK(), HOSTOK()] }))
deny(H, 'duplicate Host (evil, good)', () => req('/', { host: ['evil.com', HOSTOK()] }))
deny(H, 'duplicate Host (good, evil)', () => req('/', { host: [HOSTOK(), 'evil.com'] }))
want(H, 'X-Forwarded-Host evil with good Host is ignored', () => req('/', { headers: ['X-Forwarded-Host: evil.com'] }), 200)
deny(H, 'bad Host on /api/status with valid token', () => req('/api/status', { host: 'evil.com', headers: bearer() }))
atk(H, 'absolute-URI request line with good Host', 'no 2xx (path must start with /)', async () => { const r = await req('http://evil.com/', {}); return { ok: noSuccess(r), actual: show(r) } })

// ===== Origin =====
const O = 'Origin'
want(O, 'control: Origin http://127.0.0.1:PORT', () => req('/', { headers: [`Origin: http://127.0.0.1:${PORT}`] }), 200)
want(O, 'control: Origin http://localhost:PORT', () => req('/', { headers: [`Origin: http://localhost:${PORT}`] }), 200)
for (const [n, o] of [
  ['https://evil.com', () => 'https://evil.com'], ['null', () => 'null'], ['empty', () => ''], ['http://127.0.0.1 (no port)', () => 'http://127.0.0.1'],
  ['https://127.0.0.1:PORT (https)', () => `https://127.0.0.1:${PORT}`], ['trailing slash', () => `http://127.0.0.1:${PORT}/`],
  ['uppercase LOCALHOST (exact match only)', () => `http://LOCALHOST:${PORT}`], ['wrong port', () => `http://127.0.0.1:${PORT + 1}`],
  ['http://127.0.0.1.evil.com:PORT', () => `http://127.0.0.1.evil.com:${PORT}`], ['file://', () => 'file://'], ['chrome-extension://abc', () => 'chrome-extension://abc'],
]) want(O, `HTTP Origin ${n}`, () => req('/', { headers: [`Origin: ${o()}`] }), 403)
want(O, 'duplicate Origin headers (joined, must not match)', () => req('/', { headers: [`Origin: http://127.0.0.1:${PORT}`, `Origin: http://127.0.0.1:${PORT}`] }), 403)
want(O, 'bad Origin on /api/status with valid token', () => req('/api/status', { headers: [...bearer(), 'Origin: https://evil.com'] }), 403)
want(O, 'Sec-Fetch-Site: cross-site', () => req('/', { headers: ['Sec-Fetch-Site: cross-site'] }), 403)
want(O, 'Sec-Fetch-Site: Cross-Site (case)', () => req('/', { headers: ['Sec-Fetch-Site: Cross-Site'] }), 403)
want(O, 'Sec-Fetch-Site: same-origin allowed', () => req('/', { headers: ['Sec-Fetch-Site: same-origin'] }), 200)
want(O, 'cross-site fetch to /api/status with valid token', () => req('/api/status', { headers: [...bearer(), 'Sec-Fetch-Site: cross-site'] }), 403)

// ===== Token =====
const T = 'Token'
want(T, 'control: /api/status with correct Bearer', () => req('/api/status', { headers: bearer() }), 200)
want(T, 'no Authorization', () => req('/api/status'), 401)
want(T, 'wrong token (same length)', () => req('/api/status', { headers: bearer('A'.repeat(TOKEN.length)) }), 401)
want(T, 'empty Bearer', () => req('/api/status', { headers: ['Authorization: Bearer '] }), 401)
want(T, 'short token (prefix of real)', () => req('/api/status', { headers: bearer(TOKEN.slice(0, 10)) }), 401)
want(T, 'token minus last char', () => req('/api/status', { headers: bearer(TOKEN.slice(0, -1)) }), 401)
want(T, 'token plus suffix', () => req('/api/status', { headers: bearer(TOKEN + 'x') }), 401)
want(T, 'token doubled', () => req('/api/status', { headers: bearer(TOKEN + TOKEN) }), 401)
want(T, 'very long token (4000 chars)', () => req('/api/status', { headers: bearer('a'.repeat(4000)) }), 401)
want(T, 'lowercase "bearer" scheme', () => req('/api/status', { headers: [`Authorization: bearer ${TOKEN}`] }), 401)
want(T, 'Basic scheme with token', () => req('/api/status', { headers: [`Authorization: Basic ${TOKEN}`] }), 401)
want(T, 'raw token, no scheme', () => req('/api/status', { headers: [`Authorization: ${TOKEN}`] }), 401)
want(T, 'double space after Bearer', () => req('/api/status', { headers: [`Authorization: Bearer  ${TOKEN}`] }), 401)
want(T, 'token in query ?token=', () => req(`/api/status?token=${TOKEN}`), 401)
want(T, 'token in query ?t=', () => req(`/api/status?t=${TOKEN}`), 401)
want(T, 'token in fragment sent raw', () => req(`/api/status#t=${TOKEN}`), 401)
want(T, 'token in X-Token / Cookie headers', () => req('/api/status', { headers: [`X-Token: ${TOKEN}`, `Cookie: t=${TOKEN}`] }), 401)
want(T, 'junk query is ignored but bearer works', () => req(`/api/status?token=nope`, { headers: bearer() }), 200)
want(T, '/api/status/ trailing slash', () => req('/api/status/', { headers: bearer() }), 404)
want(T, '/API/STATUS case variant', () => req('/API/STATUS', { headers: bearer() }), 404)
want(T, '/api/status%2f (encoded slash)', () => req('/api/status%2f', { headers: bearer() }), 404)
atk(T, 'status JSON never contains the token or home dir', 'no token in body', async () => { const r = await req('/api/status', { headers: bearer() }); return { ok: r.status === 200 && !r.body.includes(TOKEN) && !r.body.includes(HOME), actual: `${r.status} len=${r.body.length}` } })
atk(T, 'HEAD /api/status with token has no body', '200, empty body', async () => { const r = await req('/api/status', { method: 'HEAD', headers: bearer() }); return { ok: r.status === 200 && r.body === '', actual: `${r.status} body=${r.body.length}` } })

// ===== WebSocket handshake =====
const W = 'WS handshake'
const ws101 = (r) => r.status === 101
const good = () => `deskmates.v1, ${TOKEN}`
atk(W, 'control: valid upgrade, no Origin', '101', async () => { const r = await upgrade('/ws', { protocols: good() }); return { ok: ws101(r), actual: show(r) } })
atk(W, 'control: valid upgrade, same-origin Origin', '101', async () => { const r = await upgrade('/ws', { origin: `http://localhost:${PORT}`, protocols: good() }); return { ok: ws101(r), actual: show(r) } })
atk(W, 'valid upgrade, comma without space', '101 (entries are trimmed)', async () => { const r = await upgrade('/ws', { protocols: `deskmates.v1,${TOKEN}` }); return { ok: ws101(r), actual: show(r) } })
atk(W, 'handshake response does not echo the token', 'subprotocol is deskmates.v1 only', async () => { const r = await upgrade('/ws', { protocols: good() }); return { ok: ws101(r) && r.headers['sec-websocket-protocol']?.[0] === 'deskmates.v1' && !r.text.includes(TOKEN), actual: r.headers['sec-websocket-protocol']?.[0] ?? show(r) } })
const wsWant = (name, opts, p, ...codes) => atk(W, name, codes.join('/'), async () => { const r = await upgrade(p, opts); return { ok: codes.includes(r.status), actual: show(r) } })
wsWant('no subprotocol (no token)', {}, '/ws', 401)
wsWant('only deskmates.v1, no token', { protocols: 'deskmates.v1' }, '/ws', 401)
wsWant('wrong token', { protocols: `deskmates.v1, ${'A'.repeat(TOKEN.length)}` }, '/ws', 401)
wsWant('short token', { protocols: `deskmates.v1, ${TOKEN.slice(0, 8)}` }, '/ws', 401)
wsWant('long token (4000 chars)', { protocols: `deskmates.v1, ${'a'.repeat(4000)}` }, '/ws', 401)
wsWant('token plus suffix', { protocols: `deskmates.v1, ${TOKEN}x` }, '/ws', 401)
wsWant('swapped order (token first)', { protocols: `${TOKEN}, deskmates.v1` }, '/ws', 401)
wsWant('three entries (extra after token)', { protocols: `deskmates.v1, ${TOKEN}, extra` }, '/ws', 401)
wsWant('three entries (extra before)', { protocols: `extra, deskmates.v1, ${TOKEN}` }, '/ws', 401)
wsWant('uppercase DESKMATES.V1', { protocols: `DESKMATES.V1, ${TOKEN}` }, '/ws', 401)
wsWant('token only, no deskmates.v1', { protocols: TOKEN }, '/ws', 401)
wsWant('duplicate deskmates.v1 entries', { protocols: 'deskmates.v1, deskmates.v1' }, '/ws', 401)
wsWant('empty subprotocol header', { protocols: '' }, '/ws', 401)
wsWant('token in query, no subprotocol', {}, `/ws?token=${TOKEN}`, 404)
wsWant('token in query with valid subprotocol (strict path)', { protocols: good() }, `/ws?token=${TOKEN}`, 404)
wsWant('wrong path /ws/', { protocols: good() }, '/ws/', 404)
wsWant('wrong path /WS', { protocols: good() }, '/WS', 404)
wsWant('wrong path /', { protocols: good() }, '/', 404)
wsWant('Origin https://evil.com with valid token', { origin: 'https://evil.com', protocols: good() }, '/ws', 403)
wsWant('Origin null with valid token', { origin: 'null', protocols: good() }, '/ws', 403)
wsWant('Origin empty with valid token', { origin: '', protocols: good() }, '/ws', 403)
wsWant('Origin wrong port with valid token', { origin: `http://127.0.0.1:${PORT + 1}`, protocols: good() }, '/ws', 403)
wsWant('Origin https same host with valid token', { origin: `https://127.0.0.1:${PORT}`, protocols: good() }, '/ws', 403)
wsWant('Host evil.com with valid token', { host: 'evil.com', protocols: good() }, '/ws', 403)
wsWant('Host localhost no port with valid token', { host: 'localhost', protocols: good() }, '/ws', 403)
wsWant('Host missing', { host: null, protocols: good() }, '/ws', 400, 403)
wsWant('duplicate Host', { host: [HOSTOK(), HOSTOK()], protocols: good() }, '/ws', 403)
wsWant('missing Sec-WebSocket-Key', { key: false, protocols: good() }, '/ws', 400)
wsWant('unsupported Sec-WebSocket-Version 7 (ws accepts 8 and 13)', { version: '7', protocols: good() }, '/ws', 400, 426)
atk(W, 'rejection responses carry security headers and no token', 'CSP + nosniff, body is reason only', async () => { const r = await upgrade('/ws', { origin: 'https://evil.com', protocols: good() }); return { ok: r.status === 403 && !!r.headers['content-security-policy'] && r.headers['x-content-type-options']?.[0] === 'nosniff' && !r.text.includes(TOKEN), actual: show(r) } })

// ===== WebSocket abuse =====
const A = 'WS abuse'
atk(A, 'valid client gets snapshot first, privacy-redacted', 'snapshot; no marker, no home dir, "~" present', async () => {
  const r = await wsConnect(); await sleep(400)
  const first = r.messages[0]?.text ?? ''
  const all = r.messages.map((m) => m.text).join('')
  const ok = r.open && r.protocol === 'deskmates.v1' && first.includes('"type":"snapshot"') && !all.includes(MARKER) && !all.includes(HOME) && !all.includes(TOKEN) && all.includes('~')
  r.ws.close()
  return { ok, actual: `open=${r.open} msgs=${r.messages.length} marker=${all.includes(MARKER)} home=${all.includes(HOME)} tilde=${all.includes('~')}` }
})
const wsSend = (name, expect, payload, expectCode, opts = {}) => atk(A, name, expect, async () => {
  const r = await wsConnect(); if (!r.open) return { ok: false, actual: `could not connect (${r.status})` }
  r.ws.send(payload, opts)
  const code = await waitClose(r)
  r.ws.terminate()
  return { ok: [].concat(expectCode).includes(code), actual: `close ${code}` }
})
wsSend('oversized text frame (5000 B > 4096)', 'close 1009', 'x'.repeat(5000), 1009)
wsSend('oversized valid-JSON frame (1 MiB)', 'close 1009', JSON.stringify({ type: 'resync', pad: 'x'.repeat(1 << 20) }), 1009)
wsSend('malformed JSON', 'close 1008', '{not json', 1008)
wsSend('empty text frame', 'close 1008', '', 1008)
wsSend('JSON array', 'close 1008', '[1,2,3]', 1008)
wsSend('JSON null', 'close 1008', 'null', 1008)
wsSend('JSON string', 'close 1008', '"resync"', 1008)
wsSend('JSON object without type', 'close 1008', '{"a":1}', 1008)
wsSend('type is not a string', 'close 1008', '{"type":{"x":1}}', 1008)
wsSend('binary frame', 'close 1008', Buffer.from([1, 2, 3, 4]), 1008, { binary: true })
wsSend('binary frame containing valid resync JSON', 'close 1008', Buffer.from('{"type":"resync"}'), 1008, { binary: true })
atk(A, 'approve/decide messages are ignored (no state change)', 'open after 2 msgs, 1008 after 20 ignored', async () => {
  const r = await wsConnect(); if (!r.open) return { ok: false, actual: 'no connect' }
  r.ws.send('{"type":"approve","id":"x"}'); r.ws.send('{"type":"decide","allow":true}'); await sleep(300)
  const stillOpen = r.ws.readyState === WebSocket.OPEN
  for (let i = 0; i < 25; i++) r.ws.send('{"type":"approve"}')
  const code = await waitClose(r)
  return { ok: stillOpen && code === 1008, actual: `open after 2=${stillOpen}, then close ${code}` }
})
atk(A, 'prototype-pollution style JSON is ignored', 'no crash; /api/status still 200', async () => {
  const r = await wsConnect(); r.ws.send('{"type":"x","__proto__":{"polluted":1},"constructor":{"prototype":{"p":1}}}'); await sleep(300); r.ws.terminate()
  const s = await req('/api/status', { headers: bearer() }); return { ok: s.status === 200, actual: show(s) }
})
atk(A, '5 resyncs in 1s allowed', 'connection stays open', async () => {
  const r = await wsConnect(); if (!r.open) return { ok: false, actual: 'no connect' }
  for (let i = 0; i < 5; i++) r.ws.send('{"type":"resync"}')
  await sleep(500); const ok = r.ws.readyState === WebSocket.OPEN; r.ws.terminate(); return { ok, actual: ok ? 'open' : 'closed' }
})
atk(A, 'rapid-fire resync x200', 'close 1008 (rate limit)', async () => {
  const r = await wsConnect(); if (!r.open) return { ok: false, actual: 'no connect' }
  for (let i = 0; i < 200; i++) r.ws.send('{"type":"resync"}')
  const code = await waitClose(r); r.ws.terminate(); return { ok: code === 1008, actual: `close ${code}` }
})
atk(A, 'rapid-fire garbage x500', 'closed, server alive', async () => {
  const r = await wsConnect(); if (!r.open) return { ok: false, actual: 'no connect' }
  for (let i = 0; i < 500; i++) { try { r.ws.send('zzz') } catch {} }
  const code = await waitClose(r); r.ws.terminate()
  const s = await req('/api/status', { headers: bearer() }); return { ok: (code === 1008 || code === 1006) && s.status === 200, actual: `close ${code}, status ${s.status}` }
})
// raw frame attacks after a real handshake
const rawWs = (frameFn, name, expect, check) => atk(A, name, expect, async () => {
  const s = net.connect(PORT, '127.0.0.1'); const chunks = []
  s.on('data', (d) => chunks.push(d)); s.on('error', () => {})
  await new Promise((r) => s.once('connect', r))
  s.write(`GET /ws HTTP/1.1\r\nHost: ${HOSTOK()}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${good()}\r\n\r\n`)
  await sleep(300)
  const mark = Buffer.concat(chunks).length
  s.write(frameFn())
  const closed = await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 2500); s.on('close', () => { clearTimeout(t); resolve(true) }) })
  const all = Buffer.concat(chunks); const after = all.subarray(mark); seen.push(all); s.destroy()
  // find a close frame (opcode 8) among the server's frames after the handshake
  let closeCode
  for (let i = 0; i + 3 < after.length; i++) if ((after[i] & 0x0f) === 8 && (after[i] & 0x80) && after[i + 1] >= 2 && after[i + 1] < 126) { closeCode = after.readUInt16BE(i + 2); break }
  return { ok: check(closed, closeCode), actual: `socket closed=${closed} closeCode=${closeCode}` }
})
const mask = [1, 2, 3, 4]
const maskedFrame = (opcode, payload, fin = true) => { const p = Buffer.from(payload); const len = p.length < 126 ? [p.length] : [126, p.length >> 8, p.length & 255]; return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len[0], ...len.slice(1), ...mask]), Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]) }
rawWs(() => Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]), 'unmasked client frame', 'close 1002 or socket closed', (c, code) => c || code === 1002)
rawWs(() => maskedFrame(1, Buffer.from([0xff, 0xfe, 0xfd])), 'invalid UTF-8 text frame', 'close 1007/1008 or socket closed', (c, code) => c || code === 1007)
rawWs(() => maskedFrame(3, 'x'), 'reserved opcode 3', 'close 1002 or socket closed', (c, code) => c || code === 1002)
rawWs(() => Buffer.concat([Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), Buffer.from(mask)]), 'frame header claims 4 GiB payload', 'close 1009 or socket closed', (c, code) => c || code === 1009)
rawWs(() => Buffer.concat([maskedFrame(1, 'a'.repeat(100), false), ...Array(60).fill(maskedFrame(0, 'a'.repeat(100), false))]), 'fragmented message exceeding 4096 B total', 'close 1009 or socket closed', (c, code) => c || code === 1009)
rawWs(() => maskedFrame(9, 'x'.repeat(200)), 'oversized ping control frame (>125 B)', 'close 1002 or socket closed', (c, code) => c || code === 1002)
atk(A, 'many connections (30 with valid token)', 'at most 20 accepted, rest 503', async () => {
  const rs = await Promise.all(Array.from({ length: 30 }, () => wsConnect()))
  const open = rs.filter((r) => r.open).length; const full = rs.filter((r) => r.status === 503).length
  rs.forEach((r) => r.ws.terminate()); await sleep(500)
  return { ok: open <= 20 && open >= 15 && open + full === 30, actual: `open=${open} 503=${full}` }
})
atk(A, 'server recovers after connection flood', 'new client accepted', async () => { await sleep(500); const r = await wsConnect(); const ok = r.open; r.ws.terminate(); return { ok, actual: ok ? 'open' : `status ${r.status}` } })

// ===== Static path traversal =====
const P = 'Path traversal'
let appJs = ''
atk(P, 'control: /app.js served', '200, javascript, nosniff', async () => { const r = await req('/app.js'); appJs = r.body; return { ok: r.status === 200 && /javascript/.test(r.headers['content-type']?.[0] ?? '') && r.headers['x-content-type-options']?.[0] === 'nosniff', actual: show(r) } })
const notFound = (name, p) => http(P, name, '404 and no file content', () => req(p), (r) => r.status === 404 && !/root:|\[boot loader\]/.test(r.body))
notFound('raw /../../../../etc/passwd', '/../../../../etc/passwd')
notFound('raw /app.js/../../../../etc/passwd', '/app.js/../../../../etc/passwd')
notFound('encoded %2e%2e/%2e%2e/etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd')
notFound('encoded dots, raw slashes ..%2f..%2f', '/..%2f..%2f..%2fetc/passwd')
notFound('encoded slashes %2e%2e%2f', '/%2e%2e%2f%2e%2e%2fetc/passwd')
notFound('double encoded %252e%252e%252f', '/%252e%252e%252f%252e%252e%252fetc/passwd')
notFound('triple encoded', '/%25252e%25252e/etc/passwd')
notFound('backslash ..\\..\\', '/..\\..\\..\\etc\\passwd')
notFound('encoded backslash %5c', '/..%5c..%5c..%5cetc%5cpasswd')
notFound('leading encoded backslash', '/%5c..%5c..%5cetc/passwd')
notFound('NUL byte /app.js%00.png', '/app.js%00.png')
notFound('NUL byte /..%2fetc/passwd%00.js', '/..%2fetc/passwd%00.js')
notFound('NUL only /%00', '/%00')
notFound('overlong UTF-8 dot %c0%ae%c0%ae', '/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd')
notFound('malformed escape /%ZZ', '/%ZZ')
notFound('lone percent /%', '/%')
notFound('fullwidth dots %EF%BC%8E%EF%BC%8E', '/%EF%BC%8E%EF%BC%8E/etc/passwd')
notFound('dotfile /.env', '/.env')
notFound('dotdir /.git/config', '/.git/config')
notFound('empty segment //etc/passwd', '//etc/passwd')
notFound('trailing slash /app.js/', '/app.js/')
notFound('dot segment /./app.js', '/./app.js')
notFound('NTFS stream /app.js::$DATA', '/app.js::$DATA')
notFound('absolute path /etc/passwd', '/etc/passwd')
notFound('directory listing /assets/', '/assets/')
notFound('one level up /../package.json', '/../package.json')
notFound('encoded dot-dot only /%2e%2e', '/%2e%2e')
atk(P, 'case variant /APP.JS', '404, or exactly the same bytes as /app.js', async () => { const r = await req('/APP.JS'); return { ok: r.status === 404 || (r.status === 200 && r.body === appJs), actual: show(r) } })
atk(P, 'query string does not change the file', '200 same bytes', async () => { const r = await req('/app.js?/../../../etc/passwd'); return { ok: r.status === 200 && r.body === appJs, actual: show(r) } })
atk(P, '/index.html is public and holds no token', '200, no token or home dir', async () => { const r = await req('/index.html'); return { ok: r.status === 200 && !r.body.includes(TOKEN) && !r.body.includes(HOME), actual: show(r) } })

// ===== Smuggling =====
const S = 'Smuggling'
const smuggled = () => 'GET /api/status HTTP/1.1\r\nHost: ' + HOSTOK()
const smug = (name, expect, build, pred) => http(S, name, expect, () => raw(build()), pred)
smug('CL + TE: chunked conflict, smuggled GET', '400/closed, never 2xx, <=1 response', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${smuggled()}\r\n\r\n`, (r) => noSuccess(r) && r.count <= 1)
smug('TE + CL (reverse header order)', '400/closed, never 2xx', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n${smuggled()}\r\n\r\n`, (r) => noSuccess(r) && r.count <= 1)
smug('two different Content-Length headers', '400 or closed', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nContent-Length: 0\r\nContent-Length: 40\r\n\r\n${smuggled()}\r\n\r\n`, (r) => rejected(r) && noSuccess(r) && r.count <= 1)
smug('non-numeric Content-Length', '400 or closed', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nContent-Length: abc\r\n\r\n`, (r) => rejected(r) && noSuccess(r))
smug('negative Content-Length', '400 or closed', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nContent-Length: -1\r\n\r\n`, (r) => rejected(r) && noSuccess(r))
smug('obfuscated "Transfer-Encoding : chunked"', '400/closed, no 2xx, <=1 response', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nTransfer-Encoding : chunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n${smuggled()}\r\n\r\n`, (r) => noSuccess(r) && r.count <= 1)
smug('TE: xchunked', '4xx, 5xx or closed', () => `POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nTransfer-Encoding: xchunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n`, (r) => noSuccess(r))
smug('bare LF line endings with evil Host', 'no 2xx', () => `GET / HTTP/1.1\nHost: evil.com\n\n`, (r) => noSuccess(r))
smug('CR injection in Host header value', 'no 2xx', () => `GET / HTTP/1.1\r\nHost: ${HOSTOK()}\rX-Evil: 1\r\nConnection: close\r\n\r\n`, (r) => noSuccess(r))
smug('pipelined good then evil Host', '200 then 403 (each request checked)', () => `GET / HTTP/1.1\r\nHost: ${HOSTOK()}\r\n\r\nGET / HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n`, (r) => r.count === 2 && /HTTP\/1\.1 200[\s\S]*HTTP\/1\.1 403/.test(r.text))
smug('pipelined evil then good Host', '403 first, no 200', () => `GET / HTTP/1.1\r\nHost: evil.com\r\n\r\nGET /api/status HTTP/1.1\r\nHost: ${HOSTOK()}\r\nConnection: close\r\n\r\n`, (r) => r.status === 403 && !/HTTP\/1\.1 200/.test(r.text) && !r.text.includes('"server"'))
smug('request line with spaces in path', '4xx or closed', () => `GET /app.js /etc/passwd HTTP/1.1\r\nHost: ${HOSTOK()}\r\n\r\n`, (r) => rejected(r) && noSuccess(r))
smug('invalid HTTP version', '4xx/5xx or closed', () => `GET / HTTP/9.9\r\nHost: ${HOSTOK()}\r\n\r\n`, (r) => rejected(r) && noSuccess(r))
smug('HTTP/2 prior-knowledge preface', 'no 2xx', () => `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`, (r) => noSuccess(r))
http(S, 'Expect: 100-continue POST with evil Host', 'no 2xx', () => req('/', { host: 'evil.com', method: 'POST', headers: ['Expect: 100-continue', 'Content-Length: 10'] }), (r) => noSuccess(r))

// ===== Size limits =====
const Z = 'Size limits'
http(Z, 'URL 9000 bytes (> 8 KiB header limit)', '4xx/5xx or closed', () => req('/' + 'a'.repeat(9000)), (r) => rejected(r) && noSuccess(r))
http(Z, 'URL 70000 bytes', '4xx/5xx or closed', () => req('/' + 'a'.repeat(70000)), (r) => rejected(r) && noSuccess(r))
http(Z, 'single header 9000 bytes', '4xx/5xx or closed', () => req('/', { headers: [`X-Big: ${'a'.repeat(9000)}`] }), (r) => rejected(r) && noSuccess(r))
http(Z, '1200 small headers (~22 KB; Node counts many small headers loosely, ~16 KB cap)', '4xx/5xx or closed', () => req('/', { headers: Array.from({ length: 1200 }, (_, i) => `X-${i}: aaaaaaaaaa`) }), (r) => rejected(r) && noSuccess(r))
http(Z, 'Authorization header 7000 bytes (under limit)', '401, no crash', () => req('/api/status', { headers: [`Authorization: Bearer ${'a'.repeat(7000)}`] }), (r) => is(r, 401))
http(Z, 'path 7000 bytes (under limit)', '404', () => req('/' + 'a'.repeat(7000)), (r) => is(r, 404))
atk(Z, 'POST with 10 MiB Content-Length, 64 KiB sent', '405 immediately, no state change', async () => {
  const s = net.connect(PORT, '127.0.0.1'); const chunks = []; s.on('data', (d) => chunks.push(d)); s.on('error', () => {})
  await new Promise((r) => s.once('connect', r))
  s.write(`POST /api/status HTTP/1.1\r\nHost: ${HOSTOK()}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n${'a'.repeat(65536)}`)
  await sleep(700); s.destroy(); const buf = Buffer.concat(chunks); seen.push(buf)
  const st = Number(/HTTP\/1\.1 (\d{3})/.exec(buf.toString('latin1'))?.[1]); return { ok: st === 405, actual: String(st) }
})
http(Z, 'GET with 10 MiB body claimed', 'served normally or closed, no crash', () => req('/', { headers: ['Content-Length: 10485760'] }), (r) => is(r, 200) || r.status === undefined)
http(Z, 'chunked POST body, 1 MiB', '405 or closed, no 2xx', () => raw(`POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n100000\r\n${'a'.repeat(1 << 20)}\r\n0\r\n\r\n`), (r) => noSuccess(r))
atk(Z, 'server healthy after size attacks', '/api/status 200', async () => { const r = await req('/api/status', { headers: bearer() }); return { ok: is(r, 200), actual: show(r) } })

// ===== Methods / state-changing endpoints =====
const M = 'Methods'
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'OPTIONS', 'PROPFIND']) want(M, `${m} / with valid token and Origin`, () => req('/', { method: m, headers: [...bearer(), `Origin: http://127.0.0.1:${PORT}`, 'Content-Length: 0'] }), 405)
for (const p of ['/api/status', '/api/approve', '/api/decide', '/api/deny', '/api/settings', '/api/resync', '/api/hooks/install', '/hook', '/ws']) want(M, `POST ${p} (probe for state-changing endpoint)`, () => req(p, { method: 'POST', headers: [...bearer(), 'Content-Type: application/json', 'Content-Length: 2'], body: '{}' }), 405)
want(M, 'unknown method FOO (llhttp rejects before the app)', () => req('/', { method: 'FOO', headers: bearer() }), 400, 405)
want(M, 'DELETE /api/status with valid token', () => req('/api/status', { method: 'DELETE', headers: bearer() }), 405)
want(M, 'form-encoded POST (CSRF style) with evil Origin', () => req('/api/approve', { method: 'POST', headers: ['Origin: https://evil.com', 'Content-Type: application/x-www-form-urlencoded', 'Content-Length: 7'], body: 'allow=1' }), 405)
want(M, 'CORS preflight OPTIONS from evil origin', () => req('/api/status', { method: 'OPTIONS', headers: ['Origin: https://evil.com', 'Access-Control-Request-Method: POST', 'Access-Control-Request-Headers: authorization'] }), 405)
want(M, 'method override header on GET is ignored', () => req('/api/status', { headers: [...bearer(), 'X-HTTP-Method-Override: DELETE'] }), 200)
want(M, 'POST with evil Host is refused', () => req('/', { method: 'POST', host: 'evil.com', headers: ['Content-Length: 0'] }), 403)
http(M, 'CONNECT 127.0.0.1:PORT tunnel', 'no 2xx, refused or closed', () => raw(`CONNECT 127.0.0.1:${PORT} HTTP/1.1\r\nHost: ${HOSTOK()}\r\n\r\n`), (r) => noSuccess(r))
http(M, 'CONNECT evil.com:443 proxy attempt', 'no 2xx', () => raw(`CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n`), (r) => noSuccess(r))
atk(M, 'no state change: status counters stable after mutation attempts', 'ws.accepted/clients/resyncs/ingest unchanged', async () => {
  await sleep(300)
  const a = JSON.parse((await req('/api/status', { headers: bearer() })).body)
  for (const m of ['POST', 'PUT', 'DELETE']) await req('/api/decide', { method: m, headers: bearer() })
  const b = JSON.parse((await req('/api/status', { headers: bearer() })).body)
  const k = (x) => JSON.stringify([x.ws.accepted, x.ws.clients, x.ws.resyncs, x.ingest])
  return { ok: k(a) === k(b), actual: k(a) === k(b) ? 'unchanged' : 'changed' }
})

// ===== Slowloris / timeouts =====
const L = 'Timeouts'
atk(L, 'slowloris: partial headers never completed', 'server closes socket (<= 45 s)', async () => {
  const t = Date.now()
  const r = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1'); let closed = false
    s.on('error', () => {}); s.on('close', () => { closed = true; resolve(true) })
    s.on('connect', () => { s.write(`GET / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nX-Slow: `); const iv = setInterval(() => { if (!closed) s.write('a'); else clearInterval(iv) }, 1000) })
    setTimeout(() => { s.destroy(); resolve(false) }, 45000)
  })
  return { ok: r, actual: r ? `closed after ${Math.round((Date.now() - t) / 1000)}s` : 'still open after 45s' }
})
atk(L, 'slow body drip on refused POST', '405 returned immediately', async () => {
  const s = net.connect(PORT, '127.0.0.1'); const chunks = []; s.on('data', (d) => chunks.push(d)); s.on('error', () => {})
  await new Promise((r) => s.once('connect', r))
  s.write(`POST / HTTP/1.1\r\nHost: ${HOSTOK()}\r\nContent-Length: 1000\r\n\r\nabc`); await sleep(500)
  const text = Buffer.concat(chunks).toString('latin1'); s.destroy(); return { ok: /HTTP\/1\.1 405/.test(text), actual: text.split('\r\n')[0] }
})
atk(L, '95 idle connections (maxConnections 100), legit request still served', 'status 200 while idle sockets held', async () => {
  const socks = []
  for (let i = 0; i < 95; i++) { const s = net.connect(PORT, '127.0.0.1'); s.on('error', () => {}); socks.push(s) }
  await sleep(600)
  const r = await req('/api/status', { headers: bearer() })
  socks.forEach((s) => s.destroy()); await sleep(300)
  return { ok: is(r, 200), actual: show(r) }
})
atk(L, '150 idle connections exceed cap, then recovery', 'extras dropped; serves again after release', async () => {
  const socks = []
  for (let i = 0; i < 150; i++) { const s = net.connect(PORT, '127.0.0.1'); s.on('error', () => {}); socks.push(s) }
  await sleep(1000)
  const dropped = socks.filter((s) => s.destroyed).length
  socks.forEach((s) => s.destroy()); await sleep(800)
  const r = await req('/api/status', { headers: bearer() })
  return { ok: is(r, 200) && dropped > 0, actual: `dropped=${dropped}, after release ${show(r)}` }
})
atk(L, 'keep-alive connection closes when idle (keepAliveTimeout 5 s)', 'closed within ~15 s', async () => {
  const t = Date.now()
  const closed = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1'); s.on('error', () => {}); s.on('close', () => resolve(true))
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: ${HOSTOK()}\r\n\r\n`)); s.on('data', () => {})
    setTimeout(() => { s.destroy(); resolve(false) }, 15000)
  })
  return { ok: closed, actual: closed ? `closed after ${Math.round((Date.now() - t) / 1000)}s` : 'open after 15s' }
})
atk(L, 'idle WS stays usable', 'idle 2 s then resync gets a snapshot', async () => {
  const r = await wsConnect(); await sleep(2000); const n = r.messages.length; r.ws.send('{"type":"resync"}'); await sleep(400)
  const ok = r.open && r.messages.length > n; r.ws.terminate(); return { ok, actual: `msgs ${n}->${r.messages.length}` }
})

// ===== Leaks and headers =====
const K = 'Leaks/headers'
const hdrCheck = (name, call, status) => atk(K, name, 'security headers, no CORS/cookie/Server/Location', async () => {
  const r = await call(); const h = r.headers
  const csp = h['content-security-policy']?.[0] ?? ''
  const bad = []
  if (r.status !== status) bad.push(`status ${r.status}`)
  if (!/default-src 'self'/.test(csp) || !/frame-ancestors 'none'/.test(csp) || !/object-src 'none'/.test(csp) || /unsafe-/.test(csp) || /\*/.test(csp)) bad.push('csp')
  if (h['x-content-type-options']?.[0] !== 'nosniff') bad.push('nosniff')
  if (h['referrer-policy']?.[0] !== 'no-referrer') bad.push('referrer-policy')
  if (h['x-frame-options']?.[0] !== 'DENY') bad.push('xfo')
  if (h['cross-origin-resource-policy']?.[0] !== 'same-origin') bad.push('corp')
  for (const k of Object.keys(h)) if (k.startsWith('access-control-') || k === 'set-cookie' || k === 'x-powered-by' || k === 'server' || k === 'location') bad.push(k)
  return { ok: bad.length === 0, actual: bad.length ? bad.join(',') : 'ok' }
})
hdrCheck('headers on / (200)', () => req('/'), 200)
hdrCheck('headers on /app.js (200)', () => req('/app.js'), 200)
hdrCheck('headers on 404', () => req('/nope'), 404)
hdrCheck('headers on 403 (bad Host)', () => req('/', { host: 'evil.com' }), 403)
hdrCheck('headers on 405', () => req('/', { method: 'POST' }), 405)
hdrCheck('headers on 401', () => req('/api/status'), 401)
hdrCheck('headers on /api/status (200)', () => req('/api/status', { headers: bearer() }), 200)
atk(K, 'Cache-Control no-store on / and /api/status', 'no-store', async () => { const a = await req('/'); const b = await req('/api/status', { headers: bearer() }); return { ok: a.headers['cache-control']?.[0] === 'no-store' && b.headers['cache-control']?.[0] === 'no-store', actual: `${a.headers['cache-control']} / ${b.headers['cache-control']}` } })
atk(K, 'no CORS allow even for allowed Origin', 'no Access-Control-* header', async () => { const r = await req('/', { headers: [`Origin: http://127.0.0.1:${PORT}`] }); const c = Object.keys(r.headers).filter((k) => k.startsWith('access-control-')); return { ok: c.length === 0, actual: c.join(',') || 'none' } })
atk(K, 'error bodies are generic', 'short fixed strings, no paths', async () => {
  const rs = await Promise.all([req('/nope'), req('/', { host: 'evil.com' }), req('/', { method: 'POST' }), req('/api/status'), req('/%ZZ')])
  const ok = rs.every((r) => r.body.length < 32 && !r.body.includes(HOME) && !r.body.includes(TOKEN) && !/at .*\.(js|ts):\d+/.test(r.body))
  return { ok, actual: rs.map((r) => `${r.status}:${JSON.stringify(r.body)}`).join(' ') }
})
atk(K, 'no stack traces on malformed request', 'no "Error" or file paths', async () => { const r = await raw(`GET /%\r\n\r\n`); return { ok: !/Error|node_modules|\/Users\//.test(r.text), actual: show(r) } })
atk(K, 'index shell has no data', 'no marker or home dir', async () => { const r = await req('/'); return { ok: !r.body.includes(MARKER) && !r.body.includes(HOME), actual: show(r) } })

// ---------- runner ----------
const finalChecks = () => {
  const all = Buffer.concat(seen).toString('latin1')
  const n = (s) => all.split(s).length - 1
  return [
    ['Leaks/headers', 'GLOBAL: token never appears in any server response (HTTP or WS)', 'zero occurrences', n(TOKEN) === 0, `${n(TOKEN)} occurrences over ${seen.length} responses`],
    ['Leaks/headers', 'GLOBAL: transcript marker never appears in any response', 'zero occurrences', n(MARKER) === 0, `${n(MARKER)} occurrences`],
    ['Leaks/headers', 'GLOBAL: home dir never appears in any response', 'zero occurrences', n(HOME) === 0, `${n(HOME)} occurrences`],
    ['Leaks/headers', 'GLOBAL: CLI stderr holds no token, marker or home dir', 'clean', !stderr.includes(TOKEN) && !stderr.includes(MARKER) && !stderr.includes(HOME), `stderr ${stderr.length} bytes`],
    ['Leaks/headers', 'GLOBAL: CLI stdout holds no marker and no home dir', 'clean (token only in launch URL)', !stdout.includes(MARKER) && !stdout.includes(HOME), `stdout ${stdout.length} bytes`],
  ]
}

const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '~' : s.padEnd(n))
const results = []
const runOne = async (a) => {
  let ok = false; let actual
  try { ({ ok, actual } = await a.fn()) } catch (e) { actual = `threw ${e?.message}` }
  results.push({ cat: a.cat, name: a.name, expect: a.expect, actual: String(actual), ok })
}

const main = async () => {
  await sleep(1500) // let ingest pick up the fixture
  // Long-running timeout attacks run in the background while the rest runs sequentially.
  const bgAttacks = attacks.filter((a) => a.name.startsWith('slowloris') || a.name.startsWith('keep-alive connection closes'))
  const bg = Promise.all(bgAttacks.map(runOne))
  for (const a of attacks) if (!bgAttacks.includes(a)) await runOne(a)
  await bg
  for (const [cat, name, expect, ok, actual] of finalChecks()) results.push({ cat, name, expect, actual, ok })

  const order = [...new Set(attacks.map((a) => a.cat))]
  results.sort((x, y) => order.indexOf(x.cat) - order.indexOf(y.cat))
  console.log(`${pad('CATEGORY', 14)} ${pad('ATTACK', 58)} ${pad('EXPECTED', 34)} ${pad('ACTUAL', 30)} RESULT`)
  for (const r of results) console.log(`${pad(r.cat, 14)} ${pad(r.name, 58)} ${pad(r.expect, 34)} ${pad(r.actual, 30)} ${r.ok ? 'PASS' : 'FAIL'}`)
  const fails = results.filter((r) => !r.ok)
  console.log('\nBy category:')
  for (const c of order) { const rs = results.filter((r) => r.cat === c); console.log(`  ${pad(c, 16)} ${rs.filter((r) => r.ok).length}/${rs.length} pass`) }
  console.log(`\nTOTAL ${results.length} attacks, ${results.length - fails.length} PASS, ${fails.length} FAIL`)
  for (const f of fails) console.log(`FAIL: [${f.cat}] ${f.name}: expected ${f.expect}, got ${f.actual}`)
  // clean shutdown: SIGINT, then SIGKILL if it lingers
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGINT')
  const clean = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!clean) { child.kill('SIGKILL'); console.log('CLI needed SIGKILL (no exit within 5 s of SIGINT)') } else console.log('CLI exited cleanly on SIGINT')
  process.exitCode = fails.length ? 1 : 0
}
main().catch((e) => { console.error('harness error:', e.message); process.exitCode = 2 })
