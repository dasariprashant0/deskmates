import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { SourceRef } from '@deskmates/provider-claude'
import { safeCode } from './codes'

export type TailEvent = { src: SourceRef; line: string }
export type TailFile = {
  stat(): Promise<{ ino: number; size: number; mtimeMs: number; isFile?(): boolean }>
  read(b: Buffer, o: number, l: number, pos: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
export type TailerOpts = {
  onLine(e: TailEvent): void
  onRemove?(filePath: string): void
  onReset?(filePath: string): void
  openFile?(filePath: string): Promise<TailFile>
  statFile?(filePath: string): Promise<{ ino: number; size: number; mtimeMs: number }>
  isStopped?(): boolean
  maxLineBytes?: number
  chunkSize?: number
  recentMs?: number
  /** A recent file bigger than this is backfilled from its last N bytes only (default 4 MiB). */
  backfillMaxBytes?: number
  now?: () => number
}
type Entry = {
  src: SourceRef
  ino?: number
  offset: number
  seen: boolean
  parts: Buffer[]
  partLen: number
  discarding: boolean
  head?: Buffer
  tail?: Buffer
  mtimeMs?: number
  removed: boolean
  failed: boolean
  skipUntil: number
  fails: number
  idleUntil: number // an old, unchanged file is not even stat'ed before this time
}

const HEAD = 64
const IDLE_AGE_MS = 60_000
const IDLE_RECHECK_MS = 2000
const NL = 0x0a
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000
const codeOf = (e: unknown) => safeCode((e as { code?: unknown } | null)?.code)

export class Tailer {
  private readonly entries = new Map<string, Entry>()
  private readonly maxLine: number
  private readonly recentMs: number
  private readonly backfillMax: number
  private readonly now: () => number
  private counts = { lines: 0, skippedOversize: 0, resets: 0 }
  private errors: Record<string, number> = {}
  private lastError?: { code: string; at: number }
  private inflight?: Promise<void>
  private readonly chunk: number
  private readonly buf: Buffer // shared: poll() is serialized
  private readonly hb = Buffer.allocUnsafe(HEAD)

  constructor(private readonly opts: TailerOpts) {
    this.maxLine = opts.maxLineBytes ?? 1_048_576
    this.recentMs = opts.recentMs ?? 600_000
    this.now = opts.now ?? Date.now
    this.backfillMax = opts.backfillMaxBytes ?? 4_194_304
    this.chunk = Math.max(1, opts.chunkSize ?? 65536)
    this.buf = Buffer.allocUnsafe(this.chunk)
  }

  add(src: SourceRef): void {
    if (!this.entries.has(src.filePath)) {
      this.entries.set(src.filePath, {
        src, offset: 0, seen: false, parts: [], partLen: 0, discarding: false, removed: false, failed: false, skipUntil: 0, fails: 0, idleUntil: 0,
      })
    }
  }

  remove(filePath: string): void {
    const e = this.entries.get(filePath)
    if (e) e.removed = true
    this.entries.delete(filePath)
  }

  stats() {
    let failing = 0
    for (const e of this.entries.values()) if (e.failed) failing++
    return {
      sources: this.entries.size, ...this.counts, errors: { ...this.errors }, failing,
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    }
  }

  private record(raw: unknown): void {
    const code = safeCode(raw)
    this.errors[code] = (this.errors[code] ?? 0) + 1
    this.lastError = { code, at: this.now() }
  }

  private halt(e: Entry): boolean {
    return e.removed || (this.opts.isStopped?.() ?? false)
  }

  /** Bytes currently held in partial-line buffers (for tests and diagnostics). */
  bufferedBytes(): number {
    let n = 0
    for (const e of this.entries.values()) n += e.partLen
    return n
  }

  poll(): Promise<void> {
    return (this.inflight ??= this.run().finally(() => { this.inflight = undefined }))
  }

  private async run(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      if (this.halt(e)) continue
      if (this.now() < e.skipUntil) continue
      try {
        await this.readOne(e)
        e.failed = false
        e.fails = 0
      } catch (err) {
        if (e.removed) continue
        const c = codeOf(err)
        if (c === 'ENOENT') {
          if (this.entries.get(e.src.filePath) === e) { this.entries.delete(e.src.filePath); this.opts.onRemove?.(e.src.filePath) }
        } else {
          e.failed = true
          this.record(c)
          e.skipUntil = this.now() + Math.min(BACKOFF_BASE_MS * 2 ** Math.min(e.fails, 16), BACKOFF_MAX_MS)
          e.fails++
        }
      }
    }
  }

  private reset(e: Entry) {
    e.offset = 0; e.parts = []; e.partLen = 0; e.discarding = false; e.head = undefined; e.tail = undefined
    this.counts.resets++
    try { this.opts.onReset?.(e.src.filePath) } catch { this.record('CALLBACK') }
  }

  private async readAt(fh: TailFile, b: Buffer, len: number, pos: number): Promise<number> {
    return (await fh.read(b, 0, len, pos)).bytesRead
  }

  private async headOk(fh: TailFile, e: Entry): Promise<boolean> {
    for (const [fp, pos] of [[e.head, 0], [e.tail, e.offset - (e.tail?.length ?? 0)]] as const) {
      if (!fp) continue
      const n = await this.readAt(fh, this.hb, fp.length, pos)
      if (n !== fp.length || this.hb.compare(fp, 0, n, 0, n) !== 0) return false
    }
    return true
  }

  private async readOne(e: Entry): Promise<void> {
    const p = e.src.filePath
    if (e.seen) {
      if (this.now() < e.idleUntil) return
      // cheap check so an idle file costs one stat, not an open
      const s = await (this.opts.statFile ?? stat)(p)
      if (s.ino === e.ino && s.size === e.offset && s.mtimeMs === e.mtimeMs) {
        // ponytail: an old file that did not change is re-checked every 2 s instead of every poll; a write to a
        // file idle for over a minute is noticed up to 2 s late. Active files keep the full poll rate.
        if (this.now() - s.mtimeMs > IDLE_AGE_MS) e.idleUntil = this.now() + IDLE_RECHECK_MS
        return
      }
      e.idleUntil = 0
    }
    // O_NONBLOCK: opening a FIFO swapped in at the path must not block a libuv thread
    const fh = await (this.opts.openFile ?? ((f) => open(f, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))))(p)
    let ok = false
    try {
      const st = await fh.stat()
      if ((st as { isDirectory?(): boolean }).isDirectory?.()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' })
      if (st.isFile && !st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOTFILE' })
      if (!e.seen) {
        e.seen = true
        e.ino = st.ino
        if (this.now() - st.mtimeMs <= this.recentMs) {
          // Huge recent file: replay only the last backfillMax bytes, dropping the partial line at the cut.
          e.offset = st.size > this.backfillMax ? st.size - this.backfillMax : 0
          e.discarding = e.offset > 0
          if (e.discarding) this.counts.skippedOversize++ // the cut line is skipped; counted so it stays observable
        } else {
          e.offset = st.size
          if (st.size > 0) e.discarding = (await this.readAt(fh, this.hb, 1, st.size - 1)) === 1 && this.hb[0] !== NL
        }
      } else if (st.ino !== e.ino || st.size < e.offset || !(await this.headOk(fh, e))) {
        e.ino = st.ino
        this.reset(e)
      }
      while (e.offset < st.size) {
        if (this.halt(e)) return
        const { bytesRead } = await fh.read(this.buf, 0, Math.min(this.chunk, st.size - e.offset), e.offset)
        if (this.halt(e)) return
        if (bytesRead === 0) break
        e.offset += bytesRead
        this.feed(e, this.buf.subarray(0, bytesRead))
      }
      const have = e.head?.length ?? 0
      const want = Math.min(HEAD, e.offset)
      if (want > have && !this.halt(e) && (await this.readAt(fh, this.hb, want, 0)) === want) {
        e.head = Buffer.from(this.hb.subarray(0, want))
      }
      // ponytail: head + last-64-bytes fingerprints plus size/mtime. Undetectable: a same-size rewrite that keeps
      // both the first 64 bytes and the 64 bytes before the offset identical, and a same-size rewrite within one
      // coarse mtime tick. Upgrade: hash the whole prefix, or use file watching.
      const tw = Math.min(HEAD, e.offset)
      if (tw > 0) {
        if (!this.halt(e) && (await this.readAt(fh, this.hb, tw, e.offset - tw)) === tw) {
          e.tail = Buffer.from(this.hb.subarray(0, tw))
          ok = true
        }
      } else ok = true
      if (ok) e.mtimeMs = st.mtimeMs
    } finally {
      // any early exit (halt, throw, short read): drop fingerprints so the next poll re-captures rather than resets
      if (!ok) { e.tail = undefined; e.mtimeMs = undefined }
      try { await fh.close() } catch { this.record('CLOSE') }
    }
  }

  private feed(e: Entry, chunk: Buffer): void {
    let start = 0
    while (start < chunk.length) {
      const nl = chunk.indexOf(NL, start)
      const end = nl === -1 ? chunk.length : nl
      if (!e.discarding) {
        if (e.partLen + (end - start) > this.maxLine) {
          this.counts.skippedOversize++
          e.parts = []; e.partLen = 0; e.discarding = true
        } else if (end > start) {
          // copy: chunk memory is reused across reads
          e.parts.push(Buffer.from(chunk.subarray(start, end))); e.partLen += end - start
        }
      }
      if (nl === -1) return
      if (e.discarding) e.discarding = false
      else this.emit(e)
      start = nl + 1
    }
  }

  private emit(e: Entry): void {
    let line = Buffer.concat(e.parts, e.partLen).toString('utf8')
    e.parts = []; e.partLen = 0
    if (line.endsWith('\r')) line = line.slice(0, -1)
    this.counts.lines++
    if (e.removed) return
    try { this.opts.onLine({ src: e.src, line }) } catch { this.record('CALLBACK') }
  }
}
