import {
  discover, newDiscoverDiag, newParseCtx, newParseDiag, parseLine, readSubagentMeta,
  type DiscoverDiag, type ParseCtx, type ParseDiag, type SourceRef,
} from '@deskmates/provider-claude'
import type { EventBus } from './bus'
import { safeCode } from './codes'
import { Tailer, type TailerOpts } from './tail'

type Where = 'scan' | 'poll' | 'publish'
export type IngestOpts = {
  root: string; bus: EventBus; now?: () => number; maxAgeMs?: number; scanMs?: number; pollMs?: number; stopTimeoutMs?: number
  warn?: (code: string, ctx?: { where: Where | 'meta' | 'discover' }) => void
  deps?: { discover?: typeof discover; readSubagentMeta?: typeof readSubagentMeta; openFile?: TailerOpts['openFile'] }
}
export type IngestStatus = {
  running: boolean
  scan: { runs: number; lastAt?: number; lastOkAt?: number; found: number; skippedRemovals: number; consecutiveBad: number; errors: Record<string, number> }
  poll: { runs: number; lastAt?: number; errors: Record<string, number> }
  published: { events: number; errors: number; seq: number }
  meta: { corrupt: number; shape: number; spawnRetries: number }
  loop: { skippedTicks: number; stopTimedOut: number }
  lastError?: { where: Where; code: string; at: number }
  parse: ParseDiag
  discover: DiscoverDiag
  tail: ReturnType<Tailer['stats']>
}

// Only the code/name is ever recorded, never the message (may hold transcript content).
const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; name?: unknown } | null
  return safeCode(typeof x?.code === 'string' ? x.code : x?.name)
}
const BAD_SCAN_LIMIT = 5
const SPAWN_BACKOFF_BASE_MS = 2000
const SPAWN_BACKOFF_MAX_MS = 60_000

export const createIngest = (opts: IngestOpts) => {
  const now = opts.now ?? Date.now
  const maxAgeMs = opts.maxAgeMs ?? 86_400_000
  const discoverFn = opts.deps?.discover ?? discover
  const readMeta = opts.deps?.readSubagentMeta ?? readSubagentMeta
  const ctxs = new Map<string, ParseCtx>()
  const spawned = new Set<string>()
  const known = new Map<string, SourceRef>()
  const parse: ParseDiag = newParseDiag()
  const disc: DiscoverDiag = newDiscoverDiag()
  const scan: IngestStatus['scan'] = { runs: 0, found: 0, skippedRemovals: 0, consecutiveBad: 0, errors: {} }
  const poll: IngestStatus['poll'] = { runs: 0, errors: {} }
  const published = { events: 0, errors: 0 }
  const meta = { corrupt: 0, shape: 0, spawnRetries: 0 }
  const loopStats = { skippedTicks: 0, stopTimedOut: 0 }
  const spawnRetry = new Map<string, { n: number; nextAt: number }>()
  let persistentWarned = false
  let lastError: IngestStatus['lastError']
  let stopped = false

  const lastWarn: Record<string, string | undefined> = {}
  const warnOnChange = (where: Where | 'meta' | 'discover', code: string) => {
    if (lastWarn[where] === code) return
    lastWarn[where] = code
    try { opts.warn?.(code, { where }) } catch { /* ignore */ }
  }
  const fail = (where: Where, e: unknown, bucket?: Record<string, number>) => {
    const code = codeOf(e)
    if (bucket) bucket[code] = (bucket[code] ?? 0) + 1
    lastError = { where, code, at: now() }
    warnOnChange(where, code)
  }

  const emit = (ev: Parameters<EventBus['publish']>[0]): boolean => {
    try { opts.bus.publish(ev); published.events++; return true } catch (e) { published.errors++; fail('publish', e); return false }
  }

  const tailer = new Tailer({
    now,
    isStopped: () => stopped,
    ...(opts.deps?.openFile ? { openFile: opts.deps.openFile } : {}),
    onReset: (f) => { ctxs.delete(f) },
    onRemove: (f) => { ctxs.delete(f); known.delete(f); spawned.delete(f); spawnRetry.delete(f) },
    onLine: ({ src, line }) => {
      let ctx = ctxs.get(src.filePath)
      if (!ctx) { ctx = newParseCtx(); ctxs.set(src.filePath, ctx) }
      for (const ev of parseLine(src, line, ctx, now(), parse)) emit(ev)
    },
  })

  // Marked spawned only after the publish succeeded, so a failure is retried by the next scan.
  const spawn = async (src: SourceRef) => {
    const retry = spawnRetry.get(src.filePath)
    if (retry && now() < retry.nextAt) return
    const entry = known.get(src.filePath)
    let m: Awaited<ReturnType<typeof readSubagentMeta>> | undefined
    try {
      m = await readMeta(src.filePath.replace(/\.jsonl$/, '.meta.json'), (c) => {
        if (c === 'meta-corrupt') meta.corrupt++; else meta.shape++
        warnOnChange('meta', c)
      })
    } catch { m = undefined }
    if (stopped || known.get(src.filePath) !== entry) return // removed while reading meta
    const ok = emit({
      ts: now(), kind: 'agent.spawn', depth: m?.spawnDepth ?? 1,
      agent: { provider: 'claude', sessionId: src.sessionId, agentId: src.agentId, parentAgentId: undefined },
      agentType: m?.agentType, description: m?.description, viaToolUseId: m?.toolUseId,
    })
    if (ok) { spawned.add(src.filePath); spawnRetry.delete(src.filePath); return }
    const n = (retry?.n ?? 0) + 1
    if (retry) meta.spawnRetries++
    spawnRetry.set(src.filePath, { n, nextAt: now() + Math.min(SPAWN_BACKOFF_BASE_MS * 2 ** (n - 1), SPAWN_BACKOFF_MAX_MS) })
  }

  const runScan = async () => {
    scan.runs++
    delete disc.rootError // sticky from earlier scans otherwise
    const before = disc.skippedDirs + disc.skippedFiles
    let found: SourceRef[] = []
    let bad = false
    let hard = false // discover threw or root unreadable: it saw nothing, so never remove on this basis
    try {
      found = await discoverFn({ root: opts.root, maxAgeMs, now: now() }, disc)
    } catch (e) { bad = true; hard = true; fail('scan', e, scan.errors) }
    if (disc.rootError || disc.skippedDirs + disc.skippedFiles > before) {
      bad = true
      if (disc.rootError) hard = true
      warnOnChange('discover', disc.rootError ?? 'SKIPPED')
    }
    if (stopped) return // late completion after a timed-out stop(): publish/mutate nothing
    scan.found = found.length
    let complete = !bad
    scan.consecutiveBad = bad ? scan.consecutiveBad + 1 : 0
    if (!bad) persistentWarned = false
    const forceRemoval = bad && !hard && scan.consecutiveBad >= BAD_SCAN_LIMIT
    if (forceRemoval && !persistentWarned) {
      persistentWarned = true
      try { opts.warn?.('scan-persistent-skip', { where: 'scan' }) } catch { /* ignore */ }
    }
    if (bad && !forceRemoval) scan.skippedRemovals++
    else {
      const present = new Set(found.map((s) => s.filePath))
      for (const [f] of known) {
        if (!present.has(f)) { tailer.remove(f); ctxs.delete(f); known.delete(f); spawned.delete(f); spawnRetry.delete(f) }
      }
    }
    for (const src of found) {
      if (stopped) { complete = false; break }
      try {
        if (!known.has(src.filePath)) { known.set(src.filePath, src); tailer.add(src) }
        if (src.isSubagent && !spawned.has(src.filePath)) await spawn(src)
      } catch (e) { complete = false; fail('scan', e, scan.errors) }
    }
    scan.lastAt = now()
    if (complete) { scan.lastOkAt = scan.lastAt; lastWarn.scan = undefined; lastWarn.discover = undefined }
  }

  const runPoll = async () => {
    poll.runs++
    try { await tailer.poll() } catch (e) { fail('poll', e, poll.errors) }
    poll.lastAt = now()
  }

  // One in-flight promise per job, shared by the exported functions and the interval loops.
  const guard = (fn: () => Promise<void>) => {
    let p: Promise<void> | undefined
    return {
      call: () => (p ??= fn().finally(() => { p = undefined })),
      busy: () => p,
    }
  }
  const scanG = guard(runScan)
  const pollG = guard(runPoll)

  let timers: ReturnType<typeof setInterval>[] = []
  const loop = (g: ReturnType<typeof guard>, ms: number) => {
    const h = setInterval(() => {
      if (g.busy()) { loopStats.skippedTicks++; return }
      g.call().catch(() => {})
    }, ms)
    h.unref()
    return h
  }

  const status = (): IngestStatus => ({
    running: timers.length > 0,
    scan: { ...scan, errors: { ...scan.errors } },
    poll: { ...poll, errors: { ...poll.errors } },
    published: { ...published, seq: opts.bus.stats().seq },
    meta: { ...meta },
    loop: { ...loopStats },
    ...(lastError ? { lastError: { ...lastError } } : {}),
    parse: { ...parse },
    discover: { ...disc },
    tail: tailer.stats(),
  })

  return {
    start() {
      stopped = false
      if (timers.length) return
      timers = [loop(scanG, opts.scanMs ?? 2000), loop(pollG, opts.pollMs ?? 250)]
    },
    async stop() {
      stopped = true
      for (const h of timers) clearInterval(h)
      timers = []
      const pending = Promise.allSettled([scanG.busy(), pollG.busy()])
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<true>((res) => { timer = setTimeout(() => res(true), opts.stopTimeoutMs ?? 2000); timer.unref() })
      if ((await Promise.race([pending.then(() => false as const), timedOut])) === true) loopStats.stopTimedOut++
      clearTimeout(timer)
    },
    scanOnce: scanG.call, pollOnce: pollG.call,
    status, diag: status,
  }
}
