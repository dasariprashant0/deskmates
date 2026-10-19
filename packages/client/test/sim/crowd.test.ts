import type { AgentState, OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { ACTIVE_WINDOW_MS, LEAVE_FADE_MS, MAX_VISIBLE, MAX_VISIBLE_ALL } from '../../src/sim/character'
import { createSim } from '../../src/sim/sim'

const NOW = 10_000_000
const mk = (i: number, status: AgentState['status'], ageMs: number, o: Partial<AgentState> = {}): AgentState => ({
  key: `t:s${i}:main`, ref: { provider: 't', sessionId: `s${i}` }, cwd: `/w/p${i}`, status, activity: 'thinking',
  openTools: {}, openOrder: [], recent: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  startedAt: NOW - ageMs - 1000, lastEventAt: NOW - ageMs, children: [], ...o,
})
const office = (a: AgentState[]): OfficeState => ({ agents: Object.fromEntries(a.map((x) => [x.key, x])), order: a.map((x) => x.key), seq: 0 })
/** Syncs and steps for `ms`; characters enter one at a time through the door, so most checks need it. */
const settle = (sim: ReturnType<typeof createSim>, st: OfficeState, ms: number, now = NOW): void => { for (let i = 0; i < ms / 33; i++) { sim.sync(st, now); sim.step(33) } }
const run = (sim: ReturnType<typeof createSim>, ms: number): void => { for (let i = 0; i < ms / 33; i++) sim.step(33) }

describe('active-only and cap', () => {
  test('idle agents past the window get no character; recent ones do; live ones always do', () => {
    const sim = createSim()
    settle(sim, office([mk(1, 'idle', ACTIVE_WINDOW_MS + 1), mk(2, 'idle', ACTIVE_WINDOW_MS - 1000), mk(3, 'working', 3_600_000), mk(4, 'waiting', 3_600_000), mk(5, 'idle', 3_600_000, { attention: { toolUseId: 'x', source: 'hook', since: 0 } })]), 10_000)
    expect(sim.characters().map((c) => c.key).sort()).toEqual(['t:s2:main', 't:s3:main', 't:s4:main', 't:s5:main'])
    expect(sim.hiddenCount()).toBe(1)
  })

  test('activeWindowMs is an option', () => {
    const sim = createSim({ activeWindowMs: 1000 })
    sim.sync(office([mk(1, 'idle', 2000), mk(2, 'idle', 500)]), NOW)
    expect(sim.characters().map((c) => c.key)).toEqual(['t:s2:main'])
  })

  test('an agent that ages out walks to the door and fades away', () => {
    const sim = createSim({ activeWindowMs: 10_000 })
    const a = mk(1, 'idle', 0)
    sim.sync(office([a]), NOW)
    run(sim, 3000)
    expect(sim.characters()).toHaveLength(1)
    sim.sync(office([a]), NOW + 20_000)
    expect(sim.characters()).toHaveLength(1) // still walking out, not popped
    expect(sim.hiddenCount()).toBe(1)
    let fading = false
    for (let i = 0; i < 600 && sim.characters().length > 0; i++) {
      sim.step(33)
      const c = sim.characters()[0]
      if (c && c.fade < 1) fading = true
    }
    expect(fading).toBe(true)
    expect(sim.characters()).toHaveLength(0)
    expect(LEAVE_FADE_MS).toBeGreaterThan(0)
  })

  test('over the cap: live first, then most recent; the rest are counted as hidden', () => {
    const sim = createSim()
    const agents = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, 'idle', 1000 + i * 1000)), // idle, recent, ages 1..10 s
      ...Array.from({ length: 10 }, (_, i) => mk(100 + i, 'working', 100_000 + i)), // live, older
    ]
    settle(sim, office(agents), 30_000)
    const keys = sim.characters().map((c) => c.key)
    expect(keys).toHaveLength(MAX_VISIBLE)
    for (let i = 0; i < 10; i++) expect(keys).toContain(`t:s${100 + i}:main`)
    for (let i = 0; i < 6; i++) expect(keys).toContain(`t:s${i}:main`) // 6 most recent idle
    expect(keys).not.toContain('t:s9:main')
    expect(sim.hiddenCount()).toBe(4)
  })

  test('maxVisible is an option and ended agents are not counted as hidden', () => {
    const sim = createSim({ maxVisible: 2 })
    settle(sim, office([mk(1, 'working', 0), mk(2, 'working', 1), mk(3, 'working', 2), mk(4, 'done', 0, { endedAt: NOW - 1 })]), 5000)
    expect(sim.characters()).toHaveLength(2)
    expect(sim.hiddenCount()).toBe(1)
  })

  test('setShowAll lifts the window and raises the cap, and can be undone', () => {
    const sim = createSim()
    const agents = Array.from({ length: 30 }, (_, i) => mk(i, 'idle', ACTIVE_WINDOW_MS * 3 + i))
    sim.sync(office(agents), NOW)
    expect(sim.characters()).toHaveLength(0)
    expect(sim.hiddenCount()).toBe(30)
    sim.setShowAll(true)
    settle(sim, office(agents), 60_000)
    expect(sim.characters().length).toBeGreaterThan(MAX_VISIBLE)
    expect(sim.characters().length).toBeLessThanOrEqual(MAX_VISIBLE_ALL)
    sim.setShowAll(false)
    settle(sim, office(agents), 30_000)
    expect(sim.characters()).toHaveLength(0)
  })

  test('60 synthetic agents: 10 live + 50 old stay within the cap, live all present, old ones hidden', () => {
    const sim = createSim()
    const live = Array.from({ length: 10 }, (_, i) => mk(i, i % 2 ? 'working' : 'thinking', 0, { agentType: 'general-purpose' }))
    const old = Array.from({ length: 50 }, (_, i) => mk(100 + i, 'idle', ACTIVE_WINDOW_MS + 60_000 + i * 1000))
    const all = office([...old, ...live])
    for (let t = 0; t < 200; t++) { sim.sync(all, NOW + t * 33); sim.step(33); expect(sim.characters().length).toBeLessThanOrEqual(MAX_VISIBLE) }
    const keys = sim.characters().map((c) => c.key)
    for (const a of live) expect(keys).toContain(a.key)
    expect(keys).toHaveLength(10)
    expect(sim.hiddenCount()).toBe(50)
  })

  test('characters expose a short and a full numbered name', () => {
    const sim = createSim()
    const p = mk(0, 'working', 0)
    const subs = [1, 2].map((i) => mk(10 + i, 'working', 0, { key: `t:s0:g${i}`, ref: { provider: 't', sessionId: 's0', agentId: `g${i}` }, agentType: 'general-purpose', parentKey: p.key, startedAt: i }))
    settle(sim, office([p, ...subs]), 5000)
    const c = sim.characters().find((v) => v.key === 't:s0:g2')
    expect(c?.full).toBe('general-purpose #2')
    expect(c?.short).toBe('agent #2')
    expect(c?.name).toBe('general-purpose')
  })
})
