import { parseArgs, USAGE } from './args'
import { newToken } from './token'

type Server = { port: number; url: string; close(): Promise<void> }
export type Deps = {
  startServer(o: { port: number; host: '127.0.0.1'; token: string; claudeRoot: string; clientDir?: string; now?: () => number }): Promise<Server>
  openBrowser(url: string): boolean
  stdout(s: string): void
  stderr(s: string): void
  now(): number
  sleep(ms: number): Promise<void>
  onSignal(handler: (signal: string) => void): void
  exit(code: number): void
  homedir(): string
  exists(path: string): boolean
  version: string
  clientDirs: string[]
}
export type Handle = { stop(): Promise<number> }

const CLOSE_BOUND_MS = 3000
const expandHome = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p)

export const run = async (argv: string[], d: Deps): Promise<number | Handle> => {
  const args = parseArgs(argv)
  if (args.kind === 'help') { d.stdout(USAGE); return 0 }
  if (args.kind === 'version') { d.stdout(`${d.version}\n`); return 0 }
  if (args.kind === 'error') { d.stderr(`deskmates: ${args.message}\n${USAGE}`); return 2 }

  const home = d.homedir()
  const claudeRoot = expandHome(args.projectsDir ?? '~/.claude/projects', home)
  const clientDir = d.clientDirs.find((p) => d.exists(p))
  let server: Server
  try {
    server = await d.startServer({ port: args.port, host: '127.0.0.1', token: newToken(), claudeRoot, ...(clientDir !== undefined && { clientDir }), now: d.now })
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    if (code === 'port-in-use') { d.stderr(`Port ${args.port} is already in use. Try --port 0 for a free port.\n`); return 1 }
    if (code === 'listen-failed') { d.stderr(`Could not listen on port ${args.port}. Try --port 0 for a free port.\n`); return 1 }
    d.stderr('deskmates: unexpected error\n') // code name only: never the message or a stack
    return 70
  }

  d.stdout(`deskmates ${d.version}: your Claude Code sessions as a pixel office\n${server.url}\nLocal only: reading transcripts on this machine, nothing is sent anywhere.\nPress Ctrl+C to stop.\n`)
  if (args.open && !d.openBrowser(server.url)) d.stdout('Could not open a browser; open the link above.\n')

  let stopping: Promise<number> | undefined
  const stop = () => (stopping ??= (async () => {
    await Promise.race([server.close().catch(() => undefined), d.sleep(CLOSE_BOUND_MS)])
    return 0
  })())
  let signals = 0
  d.onSignal(() => {
    if (++signals > 1) { d.exit(130); return }
    void stop().then(d.exit)
  })
  return { stop }
}
