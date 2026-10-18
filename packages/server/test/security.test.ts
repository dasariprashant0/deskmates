import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SECURITY_HEADERS, checkHost, checkOrigin, checkRequest, checkToken } from '../src/security'

const P = 4321
const ok = { ok: true }

describe('checkHost', () => {
  const good = [`localhost:${P}`, `127.0.0.1:${P}`, `LOCALHOST:${P}`, `LocalHost:${P}`]
  const bad: (string | undefined)[] = [
    undefined,
    '',
    ' ',
    `localhost:${P + 1}`,
    'localhost',
    '127.0.0.1',
    `127.0.0.1.evil.com:${P}`,
    `evil.com:${P}`,
    `localhost:${P}@evil.com`,
    `localhost:${P}, evil.com`,
    `evil.com, localhost:${P}`,
    ` localhost:${P}`,
    `localhost:${P} `,
    `localhost:${P}/`,
    `localhost:${P}/x`,
    `[::1]:${P}`,
    `0.0.0.0:${P}`,
    `localhost:0${P}`,
    `localhost:${P}\t`,
    `user@localhost:${P}`,
  ]
  it.each(good)('accepts %s', (h) => expect(checkHost(h, P)).toEqual(ok))
  it.each(bad)('rejects %j with 403 and a fixed reason', (h) => {
    const r = checkHost(h, P)
    expect(r).toEqual({ ok: false, status: 403, reason: 'bad-host' })
  })
})

describe('checkOrigin', () => {
  it('allows absent', () => expect(checkOrigin(undefined, P)).toEqual(ok))
  it.each([`http://localhost:${P}`, `http://127.0.0.1:${P}`])('accepts %s', (o) =>
    expect(checkOrigin(o, P)).toEqual(ok),
  )
  it.each([
    'null',
    '',
    'file://',
    `https://localhost:${P}`,
    `http://localhost:${P + 1}`,
    `http://localhost:${P}/`,
    `http://localhost:${P}/x`,
    'http://evil.com',
    `http://127.0.0.1.evil.com:${P}`,
    `HTTP://localhost:${P}`,
    `http://localhost:${P}, http://evil.com`,
  ])('rejects %j with 403', (o) => {
    expect(checkOrigin(o, P)).toEqual({ ok: false, status: 403, reason: 'bad-origin' })
  })
})

describe('checkToken', () => {
  const T = 'a'.repeat(32)
  it('accepts the correct token', () => expect(checkToken(T, T)).toEqual(ok))
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong', 'b'.repeat(8)],
    ['same length wrong', 'a'.repeat(31) + 'b'],
    ['long', 'x'.repeat(10_000)],
  ])('rejects %s with 401', (_n, g) => {
    expect(checkToken(g, T)).toEqual({ ok: false, status: 401, reason: 'bad-token' })
  })
  it('never treats an empty expected token as matching an empty given', () => {
    expect(checkToken('', '').ok).toBe(false)
  })
  it('uses timingSafeEqual on digests, not ===', () => {
    const src = readFileSync(new URL('../src/security.ts', import.meta.url), 'utf8')
    expect(src).toContain('timingSafeEqual')
    expect(src).toContain('sha256')
  })
})

describe('checkRequest ordering', () => {
  const ctx = { port: P, token: 't'.repeat(16) }
  const goodHost = `127.0.0.1:${P}`
  it('passes a fully valid request', () => {
    expect(checkRequest({ host: goodHost, origin: `http://localhost:${P}`, token: ctx.token }, ctx)).toEqual(ok)
  })
  it('bad host beats bad token and bad origin', () => {
    expect(checkRequest({ host: 'evil.com', origin: 'http://evil.com', token: 'x' }, ctx)).toMatchObject({ status: 403, reason: 'bad-host' })
  })
  it('bad origin beats bad token', () => {
    expect(checkRequest({ host: goodHost, origin: 'http://evil.com', token: 'x' }, ctx)).toMatchObject({ status: 403, reason: 'bad-origin' })
  })
  it('then token', () => {
    expect(checkRequest({ host: goodHost }, ctx)).toMatchObject({ status: 401 })
  })
})

describe('SECURITY_HEADERS', () => {
  const h = SECURITY_HEADERS(P)
  it('has the CSP with the port', () => {
    expect(h['Content-Security-Policy']).toBe(
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${P} ws://localhost:${P}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
    )
  })
  it('has the fixed hardening headers and no CORS or Server', () => {
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('no-referrer')
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()')
    expect(Object.keys(h).some((k) => /^access-control-|^server$/i.test(k))).toBe(false)
  })
})
