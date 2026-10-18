import { expect, test, vi } from 'vitest'
import { parseArgs } from '../src/args'
import { openBrowser } from '../src/open'

test.each([
  [['--projects-dir', '--no-open']], [['--port', '--no-open']], [['--projects-dir=']],
  [['--no-open=false']], [['--help=1']], [['--version=x']],
])('rejects %j', (argv) => { expect(parseArgs(argv).kind).toBe('error') })

test('windows spawn hides the window', () => {
  const spawn = vi.fn(() => ({ unref: vi.fn() }))
  openBrowser('http://x/', { platform: 'win32', spawn: spawn as never })
  expect(spawn).toHaveBeenCalledWith('cmd', expect.anything(), expect.objectContaining({ windowsHide: true }))
})
