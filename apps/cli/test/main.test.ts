import { describe, expect, test, vi } from 'vitest'
import { run, type Deps } from '../src/main'

const setup = (over: Partial<Deps> = {}) => {
  const out: string[] = []
  const err: string[] = []
  const signals: Array<(s: string) => void> = []
  let token = ''
  const close = vi.fn(async () => undefined)
  const startServer = vi.fn(async (o: { port: number; token: string }) => {
    token = o.token
    return { port: o.port || 4321, url: `http://127.0.0.1:${o.port || 4321}/#t=${o.token}`, close }
  })
  const openBrowser = vi.fn(() => true)
  const exit = vi.fn()
  const deps: Deps = {
    startServer: startServer as never, openBrowser, exit,
    stdout: (s) => { out.push(s) }, stderr: (s) => { err.push(s) },
    now: () => 1, sleep: () => new Promise(() => undefined),
    onSignal: (h) => { signals.push(h) },
    homedir: () => '/home/u', exists: () => false, version: '9.9.9', clientDirs: ['/a/dist/client', '/b/client/dist'],
    ...over,
  }
  return { deps, out, err, signals, startServer, openBrowser, close, exit, token: () => token }
}
const handle = async (r: ReturnType<typeof run>) => { const h = await r; if (typeof h === 'number') throw new Error('exited ' + h); return h }

describe('run', () => {
  test('prints banner, url, privacy line; never the token elsewhere', async () => {
    const s = setup()
    await handle(run([], s.deps))
    const all = s.out.join('')
    expect(all.split(s.token()).length - 1).toBe(1)
    expect(all.replace(`http://127.0.0.1:7878/#t=${s.token()}`, '')).not.toContain(s.token())
    expect(all.match(/Local only: reading transcripts on this machine, nothing is sent anywhere\./g)).toHaveLength(1)
    expect(all).toContain('Press Ctrl+C to stop.')
    expect(all).toContain('http://127.0.0.1:7878/#t=')
    expect(s.err.join('')).not.toContain(s.token())
    expect(s.startServer.mock.calls[0]![0]).toMatchObject({ host: '127.0.0.1', port: 7878, claudeRoot: '/home/u/.claude/projects' })
  })
  test('opens browser unless --no-open', async () => {
    const a = setup(); await handle(run([], a.deps)); expect(a.openBrowser).toHaveBeenCalledTimes(1)
    const b = setup(); await handle(run(['--no-open'], b.deps)); expect(b.openBrowser).not.toHaveBeenCalled()
  })
  test('open failure prints fallback only', async () => {
    const s = setup({ openBrowser: () => false })
    await handle(run([], s.deps))
    expect(s.out.join('')).toContain('Could not open a browser; open the link above.')
  })
  test('port 0 passes through; ~ expands', async () => {
    const s = setup()
    await handle(run(['--port', '0', '--projects-dir', '~/x'], s.deps))
    expect(s.startServer.mock.calls[0]![0]).toMatchObject({ port: 0, claudeRoot: '/home/u/x' })
  })
  test('clientDir: first existing, else undefined', async () => {
    const s = setup({ exists: (p) => p === '/b/client/dist' })
    await handle(run([], s.deps))
    expect(s.startServer.mock.calls[0]![0]).toMatchObject({ clientDir: '/b/client/dist' })
    const t = setup(); await handle(run([], t.deps))
    expect('clientDir' in (t.startServer.mock.calls[0]![0] as object)).toBe(false)
  })
  test('port-in-use -> friendly, 1', async () => {
    const s = setup({ startServer: (async () => { throw new Error('port-in-use') }) as never })
    expect(await run(['--port', '5000'], s.deps)).toBe(1)
    expect(s.err.join('')).toContain('Port 5000 is already in use. Try --port 0 for a free port.')
  })
  test('listen-failed -> 1; token problems -> 70; unknown -> 70 without message', async () => {
    const f = (m: string) => setup({ startServer: (async () => { throw new Error(m) }) as never })
    const a = f('listen-failed'); expect(await run([], a.deps)).toBe(1); expect(a.err.join('')).toContain('Could not listen')
    const b = f('token-too-short'); expect(await run([], b.deps)).toBe(70)
    const c = f('secret /Users/me/path'); expect(await run([], c.deps)).toBe(70)
    expect(c.err.join('')).toBe('deskmates: unexpected error\n')
  })
  test('bad args exit 2 with usage; help/version exit 0', async () => {
    const a = setup(); expect(await run(['--port', 'abc'], a.deps)).toBe(2); expect(a.err.join('')).toContain('Usage')
    const b = setup(); expect(await run(['--help'], b.deps)).toBe(0); expect(b.out.join('')).toContain('Usage')
    const c = setup(); expect(await run(['--version'], c.deps)).toBe(0); expect(c.out.join('')).toBe('9.9.9\n')
  })
  test('SIGINT closes and exits 0; second signal exits 130', async () => {
    const s = setup()
    await handle(run([], s.deps))
    s.signals[0]!('SIGINT')
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(0))
    expect(s.close).toHaveBeenCalledTimes(1)
    s.signals[0]!('SIGINT')
    expect(s.exit).toHaveBeenLastCalledWith(130)
  })
  test('stop() abandons a close that never resolves after the bound', async () => {
    const sleeps: number[] = []
    const s = setup({ sleep: (ms) => { sleeps.push(ms); return Promise.resolve() } })
    s.close.mockImplementation(() => new Promise(() => undefined))
    const h = await handle(run([], s.deps))
    expect(await h.stop()).toBe(0)
    expect(sleeps).toContain(3000)
  })
})
