import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { emptyState, type AgentState, type OfficeState } from '@deskmates/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { redactHome } from '../src/redact'
import { startServer, type RunningServer } from '../src/server'
import { TOKEN43 as TOKEN } from './token'

const agent = (o: Partial<AgentState>): AgentState => ({
  key: 'claude:s:main', ref: { provider: 'claude', sessionId: 's' }, status: 'idle', activity: 'idle',
  openTools: {}, openOrder: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  startedAt: 0, lastEventAt: 0, children: [], ...o,
})
const st = (a: AgentState): OfficeState => ({ ...emptyState(), agents: { [a.key]: a }, order: [a.key] })
const one = (s: OfficeState) => Object.values(s.agents)[0] as AgentState

describe('redactHome', () => {
  it('cwd under home becomes ~/...', () => {
    expect(one(redactHome(st(agent({ cwd: '/Users/bob/proj/x' })), '/Users/bob')).cwd).toBe('~/proj/x')
  })
  it('exact home becomes ~', () => {
    expect(one(redactHome(st(agent({ cwd: '/Users/bob' })), '/Users/bob')).cwd).toBe('~')
  })
  it('a sibling like /Users/bobby is not touched', () => {
    expect(one(redactHome(st(agent({ cwd: '/Users/bobby/x' })), '/Users/bob')).cwd).toBe('/Users/bobby/x')
  })
  it('paths outside home are unchanged', () => {
    expect(one(redactHome(st(agent({ cwd: '/work/proj' })), '/Users/bob')).cwd).toBe('/work/proj')
  })
  it('title, spawnDescription, gitBranch and tool summaries are redacted', () => {
    const a = agent({
      title: '/Users/bob/notes', spawnDescription: 'edit /Users/bob/a.ts now', gitBranch: '/Users/bob/br',
      openTools: { t1: { name: 'Read', summary: '/Users/bob/s.ts', startedAt: 0 } },
    })
    const r = one(redactHome(st(a), '/Users/bob'))
    expect(r.title).toBe('~/notes')
    expect(r.spawnDescription).toBe('edit ~/a.ts now')
    expect(r.gitBranch).toBe('~/br')
    expect(r.openTools.t1?.summary).toBe('~/s.ts')
    expect(JSON.stringify(r)).not.toContain('/Users/bob')
  })
  it('does not mutate the input', () => {
    const s = st(agent({ cwd: '/Users/bob/p' }))
    const before = JSON.stringify(s)
    const r = redactHome(s, '/Users/bob')
    expect(JSON.stringify(s)).toBe(before)
    expect(r).not.toBe(s)
  })
  it("does nothing for '/' or empty home", () => {
    const s = st(agent({ cwd: '/usr/x' }))
    expect(redactHome(s, '/')).toEqual(s)
    expect(redactHome(s, '')).toEqual(s)
  })
  it('handles Windows backslash homes', () => {
    const r = one(redactHome(st(agent({ cwd: 'C:\\Users\\bob\\proj' })), 'C:\\Users\\bob'))
    expect(r.cwd).toBe('~\\proj')
    expect(one(redactHome(st(agent({ cwd: 'C:\\Users\\bobby' })), 'C:\\Users\\bob')).cwd).toBe('C:\\Users\\bobby')
  })
  it('trailing slash on homeDir still works', () => {
    expect(one(redactHome(st(agent({ cwd: '/Users/bob/p' })), '/Users/bob/')).cwd).toBe('~/p')
  })
})

describe('snapshot over a real WebSocket', () => {
  let root: string
  let home: string
  let s: RunningServer | undefined
  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'dm-fpr-root-'))
    home = await mkdtemp(join(os.tmpdir(), 'dm-fpr-home-'))
  })
  afterEach(async () => {
    await s?.close()
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })
  it('shows ~/... and never the home directory', async () => {
    const dir = join(root, '-p')
    await mkdir(dir, { recursive: true })
    const cwd = join(home, 'work', 'proj')
    const line = JSON.stringify({
      type: 'assistant', sessionId: 'sesshome', cwd, timestamp: new Date().toISOString(),
      message: { id: 'm1', model: 'example-model', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: join(home, 'a.ts') } }] },
    })
    await writeFile(join(dir, 'sesshome.jsonl'), `${line}\n`)
    s = await startServer({ port: 0, token: TOKEN, claudeRoot: root, homeDir: home, ingest: { scanMs: 50, pollMs: 50 } })
    const srv = s
    await new Promise<void>((r) => { const t = setInterval(() => { if (srv.bus.seq() > 0) { clearInterval(t); r() } }, 20) })
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['deskmates.v1', TOKEN])
    const frames: string[] = []
    ws.on('message', (d) => frames.push(d.toString()))
    const end = Date.now() + 5000
    while (!frames.some((f) => f.includes('"snapshot"')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    ws.terminate()
    const snap = frames.find((f) => f.includes('"snapshot"')) ?? ''
    expect(snap).toContain('~/work/proj')
    expect(snap).not.toContain(home)
    expect(srv.bus.state().agents['claude:sesshome:main']?.cwd).toBe(cwd) // server-side state untouched
  })
})
