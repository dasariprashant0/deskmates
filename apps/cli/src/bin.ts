import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '@deskmates/server'
import pkg from '../package.json'
import { openBrowser } from './open'
import { run } from './main'

const here = dirname(fileURLToPath(import.meta.url))
const crash = (): never => { process.stderr.write('deskmates: unexpected error\n'); process.exit(70) }
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

// Register before startServer: a signal during startup must exit cleanly, not kill by signal.
const handlers: Array<(s: string) => void> = []
let early = 0
const onEarly = (s: string) => { if (handlers.length === 0) process.exit(++early > 1 ? 130 : 0); else handlers.forEach((h) => h(s)) }
process.on('SIGINT', () => onEarly('SIGINT'))
process.on('SIGTERM', () => onEarly('SIGTERM'))

const r = await run(process.argv.slice(2), {
  startServer, openBrowser,
  stdout: (s) => { process.stdout.write(s) },
  stderr: (s) => { process.stderr.write(s) },
  now: Date.now,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms).unref()),
  onSignal: (h) => { handlers.push(h) },
  exit: (c) => process.exit(c),
  homedir, exists: existsSync, version: pkg.version,
  // bundled: dist/client next to the executable; from source: the monorepo build
  clientDirs: [join(here, 'client'), join(here, '../../../packages/client/dist')],
})
if (typeof r === 'number') process.exit(r)
