/** Screen-reader announcement queue: status transitions and selection messages share one rate-limited channel. */
export const GAP_MS = 2000

type Seen = { key: string; name: string; status: string }
export type Announcer = {
  /** Feed the visible agents every refresh; queues an alert when one moves into needs-you / maybe waiting / error. */
  observe(rows: readonly Seen[]): void
  /** Queue a plain message (selection etc.). */
  say(msg: string): void
  /** The text to announce now (queued messages joined), or undefined while rate limited or empty. */
  flush(now: number): string | undefined
}

const alertFor = (name: string, status: string): string | undefined =>
  status === 'error' ? `${name} hit an error` : status === 'needs you' || status === 'maybe waiting' ? `${name} ${status}` : undefined

export function createAnnouncer(): Announcer {
  const prev = new Map<string, string>()
  const queue: string[] = []
  let seeded = false
  let last = -Infinity
  return {
    observe(rows) {
      const first = !seeded && rows.length > 0 // ponytail: seeds on the first non-empty frame; a snapshot arriving later counts as seed
      const seen = new Set<string>()
      for (const r of rows) {
        seen.add(r.key)
        if (!first && prev.get(r.key) !== r.status) {
          const m = alertFor(r.name, r.status)
          if (m !== undefined) queue.push(m)
        }
        prev.set(r.key, r.status)
      }
      if (first) seeded = true
      for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k)
    },
    say(msg) { queue.push(msg) },
    flush(now) {
      if (queue.length === 0 || now - last < GAP_MS) return undefined
      last = now
      return queue.splice(0).join('. ')
    },
  }
}
