import { expect, test, vi } from 'vitest'
import { openBrowser } from '../src/open'

const fake = () => { const child = { unref: vi.fn(), on: vi.fn() }; return { child, spawn: vi.fn(() => child) } }
const U = 'http://127.0.0.1:1/#t=abc'

test.each([
  ['darwin', 'open', [U]],
  ['linux', 'xdg-open', [U]],
  ['win32', 'cmd', ['/c', 'start', '', U]],
] as const)('%s', (platform, cmd, args) => {
  const f = fake()
  expect(openBrowser(U, { platform, spawn: f.spawn as never })).toBe(true)
  expect(f.spawn).toHaveBeenCalledWith(cmd, args, expect.objectContaining({ detached: true, stdio: 'ignore' }))
  expect(f.child.unref).toHaveBeenCalled()
})

test('spawn throwing is swallowed and reported', () => {
  expect(openBrowser(U, { platform: 'linux', spawn: () => { throw new Error('x') } })).toBe(false)
})

test('async spawn error is swallowed', () => {
  const f = fake()
  openBrowser(U, { platform: 'linux', spawn: f.spawn as never })
  const [evt, cb] = f.child.on.mock.calls[0] as [string, () => void]
  expect(evt).toBe('error')
  expect(() => cb()).not.toThrow()
})
