import { describe, expect, test } from 'vitest'
import { parseArgs } from '../src/args'

const run = (port = 7878, open = true, projectsDir?: string) => ({ kind: 'run', port, open, ...(projectsDir !== undefined && { projectsDir }) })

describe('parseArgs', () => {
  test.each([
    [[], run()],
    [['start'], run()],
    [['--port', '0'], run(0)],
    [['start', '--port', '65535'], run(65535)],
    [['--port=9000'], run(9000)],
    [['--no-open'], run(7878, false)],
    [['--projects-dir', '/x/y'], run(7878, true, '/x/y')],
    [['--projects-dir=~/p', '--no-open', '--port', '1'], run(1, false, '~/p')],
  ])('%j', (argv, want) => { expect(parseArgs(argv as string[])).toEqual(want) })

  test.each([['--help'], ['-h'], ['start', '--help']])('help %j', (...argv) => { expect(parseArgs(argv).kind).toBe('help') })
  test.each([['--version'], ['-v']])('version %j', (...argv) => { expect(parseArgs(argv).kind).toBe('version') })

  test.each([
    [['--port', 'abc']], [['--port', '-1']], [['--port', '70000']], [['--port', '1.5']], [['--port', '']],
    [['--port']], [['--projects-dir']], [['--bogus']], [['stop']], [['start', 'start']],
  ])('error %j', (argv) => {
    const r = parseArgs(argv)
    expect(r.kind).toBe('error')
  })
})
