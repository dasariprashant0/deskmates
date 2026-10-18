import { createHash, timingSafeEqual } from 'node:crypto'

export type CheckInput = { host?: string; origin?: string; token?: string }
export type CheckResult = { ok: true } | { ok: false; status: 400 | 401 | 403; reason: string }

const OK: CheckResult = { ok: true }
const fail = (status: 400 | 401 | 403, reason: string): CheckResult => ({ ok: false, status, reason })

export const checkHost = (host: string | undefined, port: number): CheckResult => {
  if (host === undefined) return fail(403, 'bad-host')
  const h = host.toLowerCase()
  return h === `localhost:${port}` || h === `127.0.0.1:${port}` ? OK : fail(403, 'bad-host')
}

export const checkOrigin = (origin: string | undefined, port: number): CheckResult => {
  if (origin === undefined) return OK
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}` ? OK : fail(403, 'bad-origin')
}

export const checkFetchSite = (site: string | undefined): CheckResult =>
  site !== undefined && site.toLowerCase().includes('cross-site') ? fail(403, 'cross-site') : OK

const TOKEN_RE = /^[A-Za-z0-9_-]+$/
// A token must be strong enough to resist guessing and safe to carry as a Sec-WebSocket-Protocol entry.
export const tokenProblem = (token: string): 'token-too-short' | 'token-invalid-chars' | undefined =>
  token.length < 32 ? 'token-too-short' : TOKEN_RE.test(token) ? undefined : 'token-invalid-chars'

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

export const checkToken = (given: string | undefined, expected: string): CheckResult => {
  // always hash and compare so length and presence do not change the path
  const same = timingSafeEqual(digest(given ?? ''), digest(expected))
  return same && given !== undefined && expected.length > 0 ? OK : fail(401, 'bad-token')
}

export const checkRequest = (input: CheckInput, ctx: { port: number; token: string }): CheckResult => {
  const h = checkHost(input.host, ctx.port)
  if (!h.ok) return h
  const o = checkOrigin(input.origin, ctx.port)
  if (!o.ok) return o
  return checkToken(input.token, ctx.token)
}

export const SECURITY_HEADERS = (port: number): Record<string, string> => ({
  'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
})
