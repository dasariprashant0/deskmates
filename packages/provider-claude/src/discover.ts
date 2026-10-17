import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceRef } from './parse'

const ls = (d: string) => readdir(d, { withFileTypes: true }).catch(() => [])

export const discover = async (opts: { root: string; maxAgeMs: number; now: number }): Promise<SourceRef[]> => {
  const found: { ref: SourceRef; mtime: number }[] = []
  const add = async (filePath: string, ref: Omit<SourceRef, 'filePath' | 'provider'>) => {
    try {
      const mtime = (await stat(filePath)).mtimeMs
      if (opts.now - mtime <= opts.maxAgeMs) found.push({ ref: { provider: 'claude', filePath, ...ref }, mtime })
    } catch { /* vanished or unreadable */ }
  }
  for (const proj of await ls(opts.root)) {
    if (!proj.isDirectory()) continue
    const pDir = join(opts.root, proj.name)
    for (const e of await ls(pDir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        await add(join(pDir, e.name), { sessionId: e.name.slice(0, -6), isSubagent: false })
      } else if (e.isDirectory()) {
        const sDir = join(pDir, e.name, 'subagents')
        for (const f of await ls(sDir)) {
          const m = /^agent-(.+)\.jsonl$/.exec(f.name)
          if (f.isFile() && m) await add(join(sDir, f.name), { sessionId: e.name, agentId: m[1], isSubagent: true })
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((x) => x.ref)
}

export const readSubagentMeta = async (metaPath: string) => {
  try {
    const o: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
    const r = o as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    return { agentType: str(r.agentType), description: str(r.description), toolUseId: str(r.toolUseId),
      spawnDepth: typeof r.spawnDepth === 'number' ? r.spawnDepth : undefined }
  } catch {
    return undefined
  }
}
