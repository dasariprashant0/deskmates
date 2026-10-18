import { spawn as nodeSpawn } from 'node:child_process'

type Child = { unref(): void; on?(evt: 'error', cb: () => void): unknown }
export type Spawn = (cmd: string, args: string[], opts: { detached: true; stdio: 'ignore'; windowsHide?: true }) => Child

/** Returns false (never throws) when the opener could not be started. The opener receives the URL as an argument. */
export const openBrowser = (url: string, o: { platform?: string; spawn?: Spawn } = {}): boolean => {
  const platform = o.platform ?? process.platform
  const spawn = o.spawn ?? (nodeSpawn as unknown as Spawn)
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] as const
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : ['xdg-open', [url]] as const
  try {
    const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on?.('error', () => undefined) // ENOENT arrives asynchronously; do not crash
    child.unref()
    return true
  } catch {
    return false
  }
}
