import { constants } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceRef } from './parse'

/** Failures made observable; holds errno codes and counts only, never paths. */
export type DiscoverDiag = { rootError?: string; skippedDirs: number; skippedFiles: number }
export const newDiscoverDiag = (): DiscoverDiag => ({ skippedDirs: 0, skippedFiles: 0 })

const CHUNK = 64
const META_MAX_BYTES = 64 * 1024
const code = (e: unknown) => ((e as { code?: unknown })?.code as string | undefined) ?? 'UNKNOWN'

// ENOENT (vanished mid-scan) is silent unless reportEnoent (the root call); other errors go to onErr.
const ls = (d: string, onErr?: (c: string) => void, reportEnoent = false) =>
  readdir(d, { withFileTypes: true }).catch((e) => { if (reportEnoent || code(e) !== 'ENOENT') onErr?.(code(e)); return [] })

export const discover = async (opts: { root: string; maxAgeMs: number; now: number }, diag?: DiscoverDiag): Promise<SourceRef[]> => {
  const dirSkipped = () => { if (diag) diag.skippedDirs++ }
  const candidates: { filePath: string; ref: Omit<SourceRef, 'filePath' | 'provider'> }[] = []
  // A missing root is reported as ENOENT; the caller decides it means 'Claude not installed'.
  for (const proj of await ls(opts.root, (c) => { if (diag) diag.rootError = c }, true)) {
    if (!proj.isDirectory()) continue
    const pDir = join(opts.root, proj.name)
    for (const e of await ls(pDir, dirSkipped)) {
      if (e.isFile() && e.name.endsWith('.jsonl') && e.name.length > 6) {
        candidates.push({ filePath: join(pDir, e.name), ref: { sessionId: e.name.slice(0, -6), isSubagent: false } })
      } else if (e.isDirectory()) {
        const sessionDir = join(pDir, e.name)
        // ponytail: one serial readdir per session dir; batch per project with Promise.all if scans get slow
        // Dirent (no symlink following) so a symlinked 'subagents' is skipped too.
        const sub = (await ls(sessionDir, dirSkipped)).find((x) => x.name === 'subagents' && x.isDirectory())
        if (!sub) continue
        const sDir = join(sessionDir, 'subagents')
        for (const f of await ls(sDir, dirSkipped)) {
          const m = /^agent-(.+)\.jsonl$/.exec(f.name)
          if (f.isFile() && m) candidates.push({ filePath: join(sDir, f.name), ref: { sessionId: e.name, agentId: m[1], isSubagent: true } })
        }
      }
    }
  }
  const found: { ref: SourceRef; mtime: number }[] = []
  for (let i = 0; i < candidates.length; i += CHUNK) {
    await Promise.all(candidates.slice(i, i + CHUNK).map(async (c) => {
      try {
        const mtime = (await stat(c.filePath)).mtimeMs
        if (opts.now - mtime <= opts.maxAgeMs) found.push({ ref: { provider: 'claude', filePath: c.filePath, ...c.ref }, mtime })
      } catch (e) {
        if (code(e) !== 'ENOENT' && diag) diag.skippedFiles++
      }
    }))
  }
  // Newest first; ties broken by path so the order is deterministic.
  found.sort((a, b) => b.mtime - a.mtime || (a.ref.filePath < b.ref.filePath ? -1 : a.ref.filePath > b.ref.filePath ? 1 : 0))
  return found.map((x) => x.ref)
}

export const readSubagentMeta = async (metaPath: string, onWarn?: (code: 'meta-corrupt' | 'meta-shape') => void) => {
  // A throwing callback must never be re-entered from the catch below.
  const warn = (c: 'meta-corrupt' | 'meta-shape') => { try { onWarn?.(c) } catch { /* ignore */ } }
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    // O_NONBLOCK so a FIFO cannot block open; regular-file check on the handle (no TOCTOU).
    fh = await open(metaPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const st = await fh.stat()
    if (!st.isFile() || st.size > META_MAX_BYTES) { warn('meta-corrupt'); return undefined }
    const buf = Buffer.alloc(META_MAX_BYTES + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (bytesRead > META_MAX_BYTES) { warn('meta-corrupt'); return undefined }
    const o: unknown = JSON.parse(buf.toString('utf8', 0, bytesRead))
    if (!o || typeof o !== 'object' || Array.isArray(o)) { warn('meta-shape'); return undefined }
    const r = o as Record<string, unknown>
    const str = (v: unknown, max = 128) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined)
    return { agentType: str(r.agentType), description: str(r.description, 256), toolUseId: str(r.toolUseId),
      spawnDepth: typeof r.spawnDepth === 'number' ? r.spawnDepth : undefined }
  } catch (e) {
    if (code(e) !== 'ENOENT') warn('meta-corrupt')
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}
