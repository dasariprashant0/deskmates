export type Parsed =
  | { kind: 'run'; port: number; open: boolean; projectsDir?: string }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }

export const USAGE = `Usage: deskmates [start] [--port <n>] [--no-open] [--projects-dir <path>]
       deskmates --help | --version

  --port <n>            port to listen on, 0-65535 (default 7878, 0 = random)
  --no-open             do not open a browser
  --projects-dir <path> Claude Code projects directory (default ~/.claude/projects)
`

const err = (message: string): Parsed => ({ kind: 'error', message })

export const parseArgs = (argv: string[]): Parsed => {
  let port = 7878
  let open = true
  let projectsDir: string | undefined
  let started = false
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!
    let inline: string | undefined
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = (): string | undefined => inline ?? argv[++i]
    switch (a) {
      case 'start': if (started || inline !== undefined) return err('unexpected argument: start'); started = true; break
      case '--help': case '-h': if (inline !== undefined) return err(`${a} takes no value`); return { kind: 'help' }
      case '--version': case '-v': if (inline !== undefined) return err(`${a} takes no value`); return { kind: 'version' }
      case '--no-open': if (inline !== undefined) return err('--no-open takes no value'); open = false; break
      case '--port': {
        const v = value()
        if (v === undefined || v.startsWith('--') || !/^\d{1,5}$/.test(v) || Number(v) > 65535) return err('--port must be an integer from 0 to 65535')
        port = Number(v)
        break
      }
      case '--projects-dir': {
        const v = value()
        if (v === undefined || v === '' || v.startsWith('--')) return err('--projects-dir needs a path')
        projectsDir = v
        break
      }
      default: return err(`unknown argument: ${a}`)
    }
  }
  return { kind: 'run', port, open, ...(projectsDir !== undefined && { projectsDir }) }
}
