import type { AgentState, OfficeState } from '@deskmates/core'
import { describe, expect, test } from 'vitest'
import { FRAME_COUNTS, type CharacterView } from '../../src/sim/character'
import { defaultLayout as L, tilePx, type Layout, type Tile } from '../../src/sim/layout'
import { createSim, type Sim } from '../../src/sim/sim'

// ---- helpers --------------------------------------------------------------------------------
const STEP = 33
const mk = (sid: string, o: Partial<AgentState> = {}): AgentState => ({
  key: `t:${sid}:main`,
  ref: { provider: 't', sessionId: sid },
  cwd: '/home/u/proj',
  status: 'thinking',
  activity: 'thinking',
  openTools: {},
  openOrder: [],
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  startedAt: 0,
  lastEventAt: 1_000_000, // the world() clock starts here, so idle and done agents sit inside the active window
  children: [],
  ...o,
})
const office = (...a: AgentState[]): OfficeState => ({
  agents: Object.fromEntries(a.map((x) => [x.key, x])),
  order: a.map((x) => x.key),
  seq: 0,
})
const tool = (name: string, summary: string, startedAt: number) => ({ name, summary, startedAt, toolUseId: 'tu1' })
const tileOf = (v: CharacterView): Tile => ({ x: Math.floor(v.x / 16), y: Math.floor(v.y / 16) })
const sameTile = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y
const tkey = (t: Tile): string => `${t.x},${t.y}`

/** A sim plus a synthetic wall clock so sync() times track step() time. */
function world(opts: { layout?: Layout; reducedMotion?: boolean; seed?: string } = {}) {
  const sim: Sim = createSim(opts)
  let now = 1_000_000
  const w = {
    sim,
    get now() {
      return now
    },
    set(...agents: AgentState[]) {
      sim.sync(office(...agents), now)
    },
    run(ms: number, each?: (cs: CharacterView[]) => void) {
      for (let i = 0; i < Math.ceil(ms / STEP); i++) {
        sim.step(STEP)
        now += STEP
        each?.(sim.characters())
      }
    },
    get(key: string): CharacterView {
      const v = sim.characters().find((c) => c.key === key)
      if (!v) throw new Error(`no character ${key}`)
      return v
    },
  }
  return w
}
const k = (sid: string) => `t:${sid}:main`

/** One agent, thinking, seated at desk 0. */
function seated(opts: Parameters<typeof world>[0] = {}, sid = 'a') {
  const w = world(opts)
  w.set(mk(sid))
  w.run(5000)
  return w
}

// ---- spawn and desks --------------------------------------------------------------------------
describe('spawn and desks', () => {
  test('new agent appears at the door tile', () => {
    const w = world()
    w.set(mk('a'))
    const v = w.get(k('a'))
    expect(tileOf(v)).toEqual(L.doorTile)
    expect(v.x).toBe(tilePx(L.doorTile).x)
    expect(v.y).toBe(tilePx(L.doorTile).y)
    expect(v.fade).toBe(1)
  })

  test('walks to its desk at 48 px/s and sits facing the desk', () => {
    const w = world()
    w.set(mk('a'))
    w.run(2700) // 9 tiles = 144 px = 3 s
    expect(w.get(k('a')).anim).toBe('walk')
    expect(w.get(k('a')).zone).toBeUndefined()
    w.run(700)
    const v = w.get(k('a'))
    expect(tileOf(v)).toEqual(L.desks[0]?.seat)
    expect(v.zone).toBe('desk')
    expect(v.dir).toBe(L.desks[0]?.facing)
    expect(v.anim).toBe('think')
    expect(v.ring).toBe('thinking')
  })

  test('walking faces the movement direction and frames advance through all walk frames', () => {
    const w = world()
    w.set(mk('a'))
    const dirs = new Set<string>()
    const frames = new Set<number>()
    w.run(2500, (cs) => {
      const v = cs[0]
      if (v?.anim === 'walk') {
        dirs.add(v.dir)
        frames.add(v.frame)
        expect(v.frame).toBeLessThan(FRAME_COUNTS.walk)
      }
    })
    expect(dirs.has('up')).toBe(true)
    expect(dirs.has('right')).toBe(true)
    expect(frames.size).toBe(FRAME_COUNTS.walk)
  })

  test('assignment is stable by creation order; every agent sits on a distinct desk', () => {
    const w = world()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    w.set(...ids.map((i) => mk(i)))
    w.run(20_000)
    ids.forEach((id, i) => expect(tileOf(w.get(k(id)))).toEqual(L.desks[i]?.seat))
  })

  test('7th agent uses a hot desk', () => {
    const w = world()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    w.set(...ids.map((i) => mk(i)))
    w.run(25_000)
    const tiles = ids.map((id) => tileOf(w.get(k(id))))
    expect(new Set(tiles.map(tkey)).size).toBe(7)
    expect(tiles.slice(0, 6).every((t, i) => sameTile(t, L.desks[i]?.seat ?? { x: -1, y: -1 }))).toBe(true)
    expect(L.hotDesks.some((h) => sameTile(h, tiles[6] ?? { x: -1, y: -1 }))).toBe(true)
  })

  test('with desks and hot desks full, extras queue near the door and take a freed desk', () => {
    const w = world()
    const ids = Array.from({ length: 11 }, (_, i) => `n${i}`)
    w.set(...ids.map((i) => mk(i)))
    w.run(60_000)
    const tiles = ids.map((id) => tileOf(w.get(k(id))))
    expect(new Set(tiles.map(tkey)).size).toBe(11)
    expect(L.queue.some((q) => sameTile(q, tiles[10] ?? { x: -1, y: -1 }))).toBe(true)
    // desk 0's owner leaves; the queued agent eventually takes a seat
    w.set(...ids.slice(1).map((i) => mk(i)))
    w.run(60_000)
    const t10 = tileOf(w.get(k('n10')))
    expect([...L.desks.map((d) => d.seat), ...L.hotDesks].some((s) => sameTile(s, t10))).toBe(true)
  })

  test('subagents use desks too and are named by agentType', () => {
    const w = world()
    const sub = mk('a', {
      key: 't:a:sub1',
      ref: { provider: 't', sessionId: 'a', agentId: 'sub1', parentAgentId: undefined },
      agentType: 'Explore',
      parentKey: k('a'),
    })
    w.set(mk('a'), sub)
    w.run(10_000)
    expect(w.get('t:a:sub1').name).toBe('Explore')
    expect(w.get('t:a:sub1').zone).toBe('desk')
    expect(tileOf(w.get('t:a:sub1'))).toEqual(L.desks[1]?.seat)
  })
})

// ---- tools and zones --------------------------------------------------------------------------
describe('tools and zones', () => {
  test('a short tool (< 1.5 s) does not walk: plays the work animation in place with the bubble', () => {
    const w = seated()
    const home = tileOf(w.get(k('a')))
    w.set(mk('a', { status: 'working', activity: 'reading', currentTool: tool('Read', 'Read: auth.ts', w.now) }))
    const seen = new Set<string>()
    w.run(1300, (cs) => cs[0] && seen.add(cs[0].anim))
    const v = w.get(k('a'))
    expect(seen.has('walk')).toBe(false)
    expect(tileOf(v)).toEqual(home)
    expect(v.anim).toBe('read')
    expect(v.bubble).toBe('Read: auth.ts')
    expect(v.ring).toBe('working')
    expect(v.zone).toBe('desk')
  })

  test('a tool open longer than 1.5 s walks to the zone', () => {
    const w = seated()
    w.set(mk('a', { status: 'working', activity: 'reading', currentTool: tool('Read', 'Read: auth.ts', w.now) }))
    w.run(1400)
    expect(w.get(k('a')).zone).toBe('desk') // not yet
    const seen = new Set<string>()
    w.run(8000, (cs) => cs[0] && seen.add(cs[0].anim))
    expect(seen.has('walk')).toBe(true)
    expect(w.get(k('a')).zone).toBe('bookshelf')
  })

  const cases: [string, string, AgentState['activity'], string, string][] = [
    ['Read', 'Read: x.ts', 'reading', 'bookshelf', 'read'],
    ['Grep', 'Grep: foo', 'searching', 'bookshelf', 'read'],
    ['Bash', 'Bash: pnpm test', 'running', 'terminal', 'type'],
    ['Edit', 'Edit: a.ts', 'editing', 'whiteboard', 'type'],
    ['Write', 'Write: b.ts', 'typing', 'whiteboard', 'type'],
    ['WebSearch', 'WebSearch: pixel art', 'searching', 'webwall', 'read'],
    ['mcp__github__list_prs', 'mcp: list_prs', 'running', 'rack', 'type'],
  ]
  test.each(cases)('%s (%s, %s) -> %s zone with anim %s', (name, summary, activity, zone, anim) => {
    const w = seated()
    w.set(mk('a', { status: 'working', activity, currentTool: tool(name, summary, w.now - 2000) }))
    w.run(10_000)
    const v = w.get(k('a'))
    expect(v.zone).toBe(zone)
    expect(v.anim).toBe(anim)
    expect(v.ring).toBe('working')
    expect(v.bubble).toBe(summary)
    const slots = L.zones[zone as keyof typeof L.zones].slots
    expect(slots.some((s) => sameTile(s, tileOf(v)))).toBe(true)
    expect(v.dir).toBe(L.zones[zone as keyof typeof L.zones].facing)
  })

  test('Agent (parent) and TodoWrite stay at the desk', () => {
    const w = seated()
    for (const name of ['Agent', 'TodoWrite', 'SomeUnknownTool']) {
      w.set(mk('a', { status: 'working', activity: 'typing', currentTool: tool(name, name, w.now - 5000) }))
      w.run(5000)
      expect(w.get(k('a')).zone).toBe('desk')
      expect(tileOf(w.get(k('a')))).toEqual(L.desks[0]?.seat)
    }
  })

  test('dwell: no leaving a zone for 2 s after arriving (no ping-pong)', () => {
    const w = seated()
    w.set(mk('a', { status: 'working', activity: 'reading', currentTool: tool('Read', 'r', w.now - 2000) }))
    for (let i = 0; i < 400 && w.get(k('a')).zone !== 'bookshelf'; i++) w.run(STEP)
    expect(w.get(k('a')).zone).toBe('bookshelf')
    const spot = tileOf(w.get(k('a')))
    w.set(mk('a', { status: 'idle', activity: 'idle' }))
    w.run(1600)
    expect(w.get(k('a')).zone).toBe('bookshelf')
    expect(tileOf(w.get(k('a')))).toEqual(spot)
    w.run(10_000)
    expect(w.get(k('a')).zone).toBe('coffee')
  })

  test('flapping targets still make progress: dwell bounds how often an agent changes zone', () => {
    const w = seated()
    let moves = 0
    let last = ''
    for (let i = 0; i < 20; i++) {
      const long = i % 2 === 0
      w.set(
        mk('a', {
          status: 'working',
          activity: long ? 'reading' : 'running',
          currentTool: tool(long ? 'Read' : 'Bash', 'x', w.now - 3000),
        }),
      )
      w.run(500, (cs) => {
        const z = cs[0]?.zone ?? ''
        if (z && z !== last) {
          moves++
          last = z
        }
      })
    }
    expect(moves).toBeLessThanOrEqual(6) // 10 s total, >= 2 s dwell plus walking per change
  })
})

// ---- status mapping ---------------------------------------------------------------------------
describe('status mapping', () => {
  test('thinking: at own desk, anim think, ring thinking', () => {
    const w = seated()
    const v = w.get(k('a'))
    expect([v.zone, v.anim, v.ring]).toEqual(['desk', 'think', 'thinking'])
  })

  test('working without a tool: desk, type', () => {
    const w = seated()
    w.set(mk('a', { status: 'working', activity: 'typing' }))
    w.run(500)
    expect([w.get(k('a')).zone, w.get(k('a')).anim, w.get(k('a')).ring]).toEqual(['desk', 'type', 'working'])
  })

  test('attention goes to the bell zone (think, needs-you, bubble) and returns when resolved', () => {
    const w = seated()
    w.set(
      mk('a', {
        status: 'waiting',
        activity: 'idle',
        currentTool: tool('Bash', 'Bash: rm -rf dist', w.now),
        attention: { toolUseId: 'tu1', source: 'hook', since: w.now },
      }),
    )
    w.run(8000)
    const v = w.get(k('a'))
    expect(v.zone).toBe('bell')
    expect(v.anim).toBe('think')
    expect(v.ring).toBe('needs-you')
    expect(v.bubble).toBe('Bash: rm -rf dist')
    expect(L.zones.bell.slots.some((s) => sameTile(s, tileOf(v)))).toBe(true)
    w.set(mk('a', { status: 'working', activity: 'typing' })) // resolved
    w.run(8000)
    const back = w.get(k('a'))
    expect(back.zone).toBe('desk')
    expect(tileOf(back)).toEqual(L.desks[0]?.seat)
    expect(back.ring).toBe('working')
  })

  test('an attention object alone (status still working) also sends the agent to the bell', () => {
    const w = seated()
    w.set(mk('a', { status: 'working', attention: { toolUseId: 'x', source: 'heuristic', since: w.now } }))
    w.run(8000)
    expect(w.get(k('a')).zone).toBe('bell')
  })

  test('error flash lasts about 3 s, in place', () => {
    const w = seated()
    const home = tileOf(w.get(k('a')))
    w.set(mk('a', { status: 'working', activity: 'typing', lastError: { toolUseId: 'e', at: w.now } }))
    w.run(500)
    expect([w.get(k('a')).anim, w.get(k('a')).ring]).toEqual(['error', 'error'])
    w.run(2200) // t = 2.7 s
    expect(w.get(k('a')).anim).toBe('error')
    w.run(600) // t = 3.3 s
    expect(w.get(k('a')).anim).not.toBe('error')
    expect(w.get(k('a')).ring).toBe('working')
    expect(tileOf(w.get(k('a')))).toEqual(home)
  })

  test('status error stays in place with the error animation', () => {
    const w = seated()
    w.set(mk('a', { status: 'error', activity: 'idle' }))
    w.run(6000)
    expect([w.get(k('a')).anim, w.get(k('a')).ring, w.get(k('a')).zone]).toEqual(['error', 'error', 'desk'])
  })

  test('done celebrates for 3 s then goes to the coffee corner', () => {
    const w = seated()
    w.set(mk('a', { status: 'done', activity: 'idle' }))
    w.run(1000)
    expect([w.get(k('a')).anim, w.get(k('a')).ring]).toEqual(['celebrate', 'done'])
    w.run(1800)
    expect(w.get(k('a')).anim).toBe('celebrate')
    w.run(1000) // 3.8 s: celebration over, walking away
    expect(w.get(k('a')).anim).not.toBe('celebrate')
    w.run(10_000)
    const v = w.get(k('a'))
    expect(v.zone).toBe('coffee')
    expect(v.anim).toBe('idle')
    expect(v.ring).toBe('done')
    expect(L.zones.coffee.slots.some((s) => sameTile(s, tileOf(v)))).toBe(true)
  })

  test('idle goes to the coffee zone with anim idle, ring idle', () => {
    const w = seated()
    w.set(mk('a', { status: 'idle', activity: 'idle' }))
    w.run(10_000)
    const v = w.get(k('a'))
    expect([v.zone, v.anim, v.ring]).toEqual(['coffee', 'idle', 'idle'])
    expect(v.dir).toBe('down')
  })
})

// ---- contention and movement -------------------------------------------------------------------
describe('slots, queueing and deadlock', () => {
  const oneSlot: Layout = {
    ...L,
    zones: { ...L.zones, whiteboard: { ...L.zones.whiteboard, slots: [L.zones.whiteboard.slots[0] ?? { x: 8, y: 2 }] } },
  }
  const editing = (sid: string, at: number) =>
    mk(sid, { status: 'working', activity: 'editing', currentTool: tool('Edit', `Edit: ${sid}.ts`, at) })

  test('second agent waits at the waitTile (idle, "...") then takes the slot after the first leaves', () => {
    const w = world({ layout: oneSlot })
    w.set(mk('a'), mk('b'))
    w.run(10_000)
    w.set(editing('a', w.now - 2000), editing('b', w.now - 2000))
    w.run(10_000)
    const slot = oneSlot.zones.whiteboard.slots[0] as Tile
    const a = w.get(k('a'))
    const b = w.get(k('b'))
    expect(a.zone).toBe('whiteboard')
    expect(tileOf(a)).toEqual(slot)
    expect(tileOf(b)).toEqual(oneSlot.zones.whiteboard.waitTile)
    expect(b.zone).toBeUndefined()
    expect(b.anim).toBe('idle')
    expect(b.bubble).toBe('...')
    // a goes back to thinking; b takes the slot
    w.set(mk('a'), editing('b', w.now - 12_000))
    w.run(10_000)
    expect(tileOf(w.get(k('b')))).toEqual(slot)
    expect(w.get(k('b')).zone).toBe('whiteboard')
    expect(w.get(k('b')).anim).toBe('type')
    expect(w.get(k('a')).zone).toBe('desk')
  })

  test('two agents never occupy the same tile (or slot) at any step', () => {
    const w = world()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    w.set(...ids.map((i) => mk(i)))
    w.run(15_000)
    w.set(...ids.map((i) => mk(i, { status: 'working', activity: 'reading', currentTool: tool('Read', 'r', w.now - 2000) })))
    w.run(20_000, (cs) => {
      const s = cs.map((c) => tkey(tileOf(c)))
      // feet-center is in one tile; moving characters may straddle, so compare rounded-to-nearest tile distance
      for (let i = 0; i < cs.length; i++)
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i] as CharacterView
          const b = cs[j] as CharacterView
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1)
        }
      expect(s.length).toBe(ids.length)
    })
    // 8 readers, 4 bookshelf slots: 4 at the shelf, the rest waiting
    const at = ids.filter((i) => w.get(k(i)).zone === 'bookshelf')
    expect(at).toHaveLength(4)
  })

  test('deadlock: two agents in a narrow room swap goals and resolve within 3 s', () => {
    const rows = ['#....#', '......']
    const walkable = rows.map((r) => [...r].map((c) => c === '.'))
    const seat = (x: number, y: number) => ({ seat: { x, y }, facing: 'up' as const, computer: { x, y: y - 1 } })
    const layout: Layout = {
      ...L,
      walkable,
      doorTile: { x: 0, y: 1 },
      desks: [seat(2, 1), seat(3, 1)],
      hotDesks: [{ x: 5, y: 1 }],
      queue: [{ x: 1, y: 1 }],
      zones: {
        ...L.zones,
        bookshelf: { ...L.zones.bookshelf, slots: [{ x: 2, y: 1 }], waitTile: { x: 4, y: 0 } },
        coffee: { ...L.zones.coffee, slots: [{ x: 3, y: 1 }], waitTile: { x: 1, y: 0 } },
      },
    }
    const w = world({ layout })
    w.set(mk('a'), mk('b'))
    w.run(8000)
    expect(tileOf(w.get(k('a')))).toEqual({ x: 2, y: 1 })
    expect(tileOf(w.get(k('b')))).toEqual({ x: 3, y: 1 })
    // swap: a (at 2,1) -> coffee slot (3,1); b (at 3,1) -> bookshelf slot (2,1)
    w.set(
      mk('a', { status: 'idle', activity: 'idle' }),
      mk('b', { status: 'working', activity: 'reading', currentTool: tool('Read', 'r', w.now - 5000) }),
    )
    let elapsed = 0
    const done = () => w.get(k('a')).zone === 'coffee' && w.get(k('b')).zone === 'bookshelf'
    while (!done() && elapsed < 6000) {
      w.run(STEP)
      elapsed += STEP
    }
    expect(done()).toBe(true)
    expect(elapsed).toBeLessThanOrEqual(3000)
    expect(tileOf(w.get(k('a')))).toEqual({ x: 3, y: 1 })
    expect(tileOf(w.get(k('b')))).toEqual({ x: 2, y: 1 })
  })
})

// ---- leaving ----------------------------------------------------------------------------------
describe('leaving', () => {
  test('ended agents walk to the door, fade, and are dropped', () => {
    const w = seated()
    w.set(mk('a', { status: 'done', activity: 'idle', endedAt: w.now }))
    let sawDoor = false
    let sawFade = false
    let gone = false
    w.run(15_000, (cs) => {
      const v = cs[0]
      if (!v) gone = true
      else {
        if (sameTile(tileOf(v), L.doorTile)) sawDoor = true
        if (v.fade < 1) sawFade = true
        expect(v.fade).toBeGreaterThanOrEqual(0)
      }
    })
    expect(sawDoor && sawFade && gone).toBe(true)
    expect(w.sim.characters()).toHaveLength(0)
  })

  test('removed-from-state agents leave the same way; others stay', () => {
    const w = world()
    w.set(mk('a'), mk('b'))
    w.run(10_000)
    w.set(mk('b'))
    w.run(15_000)
    expect(w.sim.characters().map((c) => c.key)).toEqual([k('b')])
  })

  test('a freed desk is reused by the next agent', () => {
    const w = world()
    w.set(mk('a'))
    w.run(6000)
    w.set()
    w.run(15_000)
    expect(w.sim.characters()).toHaveLength(0)
    w.set(mk('c'))
    w.run(6000)
    expect(tileOf(w.get(k('c')))).toEqual(L.desks[0]?.seat)
  })

  test('an already-ended agent seen for the first time is not spawned', () => {
    const w = world()
    w.set(mk('a', { status: 'done', endedAt: 1 }))
    w.run(1000)
    expect(w.sim.characters()).toHaveLength(0)
  })
})

// ---- reduced motion ---------------------------------------------------------------------------
describe('reduced motion', () => {
  test('spawns at its desk (fade-in), never walks, frames are static', () => {
    const w = world({ reducedMotion: true })
    w.set(mk('a'))
    const seen = new Set<string>()
    let minFade = w.get(k('a')).fade // fade-in starts at 0 at spawn
    w.run(3000, (cs) => {
      const v = cs[0]
      if (!v) return
      seen.add(v.anim)
      minFade = Math.min(minFade, v.fade)
      expect(v.frame).toBe(0)
    })
    expect(seen.has('walk')).toBe(false)
    expect(minFade).toBe(0)
    const v = w.get(k('a'))
    expect(tileOf(v)).toEqual(L.desks[0]?.seat)
    expect(v.fade).toBe(1)
  })

  test('changing target teleports with a 150 ms fade 1 -> 0 -> 1', () => {
    const w = seated({ reducedMotion: true })
    w.set(mk('a', { status: 'working', activity: 'reading', currentTool: tool('Read', 'r', w.now - 3000) }))
    const fades: number[] = []
    const xy: [number, number][] = []
    w.run(1000, (cs) => {
      const v = cs[0]
      if (!v) return
      fades.push(v.fade)
      xy.push([v.x, v.y])
      expect(v.anim).not.toBe('walk')
      expect(v.frame).toBe(0)
    })
    const lo = fades.indexOf(Math.min(...fades))
    expect(Math.min(...fades)).toBe(0)
    expect(fades.at(-1)).toBe(1)
    expect(fades.filter((f) => f < 1).length * STEP).toBeLessThanOrEqual(200)
    // position changes only while faded out (or at the very moment fade hits 0)
    const jumps = xy.flatMap((p, i) => {
      const q = xy[i + 1]
      return q && (p[0] !== q[0] || p[1] !== q[1]) ? [i] : []
    })
    expect(jumps).toHaveLength(1)
    expect(Math.abs((jumps[0] ?? 0) - lo)).toBeLessThanOrEqual(2)
    expect(w.get(k('a')).zone).toBe('bookshelf')
  })

  test('leaving fades out in place and is dropped', () => {
    const w = seated({ reducedMotion: true })
    const before = w.get(k('a'))
    w.set(mk('a', { status: 'done', endedAt: w.now }))
    w.run(66)
    const mid = w.get(k('a'))
    expect([mid.x, mid.y]).toEqual([before.x, before.y])
    expect(mid.fade).toBeLessThan(1)
    w.run(400)
    expect(w.sim.characters()).toHaveLength(0)
  })
})

// ---- text, names, determinism, performance ------------------------------------------------------
describe('bubbles and names', () => {
  const bubbleFor = (summary: string) => {
    const w = seated()
    w.set(mk('a', { status: 'working', activity: 'reading', currentTool: tool('Read', summary, w.now) }))
    w.run(200)
    return w.get(k('a')).bubble
  }

  test('never exceeds 24 chars', () => {
    const b = bubbleFor('Read: /very/long/path/to/some/deeply/nested/file-name.ts')
    expect(b).toBeDefined()
    expect(Array.from(b ?? '').length).toBeLessThanOrEqual(24)
    expect(b?.startsWith('Read: /very/long/path')).toBe(true)
    expect(Array.from(bubbleFor('x'.repeat(24)) ?? '')).toHaveLength(24)
    expect(bubbleFor('x'.repeat(25))).toHaveLength(24)
  })

  test('markup stays literal text', () => {
    expect(bubbleFor('<img onerror=x>')).toBe('<img onerror=x>')
    expect(bubbleFor('<script>alert(1)</script>')?.startsWith('<script>alert(1)')).toBe(true)
  })

  test('control characters and newlines are flattened', () => {
    expect(bubbleFor('a\nb\u0000c')).toBe('a b c')
  })

  test('emoji are not split mid code point', () => {
    const b = bubbleFor('😀'.repeat(30)) ?? ''
    expect(Array.from(b).length).toBeLessThanOrEqual(24)
    expect(b).not.toMatch(/[\ud800-\udbff]$/)
  })

  test('names: project folder for main, agentType for subagents, session id fallback, max 16', () => {
    const w = world()
    w.set(
      mk('abcdefgh', { cwd: '/Users/me/Projects/deskmates' }),
      mk('s2', { cwd: undefined, key: 't:s2:main' }),
      mk('s3', { cwd: 'C:\\code\\a-very-long-project-name-indeed' }),
      mk('s4', { key: 't:s4:x', ref: { provider: 't', sessionId: 's4', agentId: 'x' } }),
    )
    w.run(3000) // agents appear one at a time as the door tile frees up
    const byKey = Object.fromEntries(w.sim.characters().map((c) => [c.key, c.name]))
    expect(byKey[k('abcdefgh')]).toBe('deskmates')
    expect(byKey[k('s2')]).toBe('s2')
    expect(byKey[k('s3')]).toBe('a-very-long-proj')
    expect(byKey[k('s3')]?.length).toBe(16)
    expect(byKey['t:s4:x']).toBe('s4')
  })
})

describe('determinism and performance', () => {
  const script = (w: ReturnType<typeof world>): string[] => {
    const out: string[] = []
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const kinds: Partial<AgentState>[] = [
      { status: 'thinking' },
      { status: 'working', activity: 'reading', currentTool: tool('Read', 'r', 0) },
      { status: 'working', activity: 'running', currentTool: tool('Bash', 'b', 0) },
      { status: 'idle' },
      { status: 'waiting', attention: { toolUseId: 'x', source: 'hook', since: 0 } },
      { status: 'done' },
    ]
    for (let round = 0; round < 12; round++) {
      w.set(
        ...ids.map((id, i) => {
          const kind = kinds[(round + i * 2) % kinds.length] ?? {}
          return mk(id, { ...kind, currentTool: kind.currentTool && { ...kind.currentTool, startedAt: w.now - 2000 } })
        }),
      )
      w.run(1500, (cs) => out.push(JSON.stringify(cs)))
    }
    return out
  }

  test('same seed and same inputs give identical characters() at every tick', () => {
    const a = script(world({ seed: 's1' }))
    const b = script(world({ seed: 's1' }))
    expect(a.length).toBeGreaterThan(300)
    expect(a).toEqual(b)
  })

  test('same in reduced motion', () => {
    expect(script(world({ seed: 's1', reducedMotion: true }))).toEqual(script(world({ seed: 's1', reducedMotion: true })))
  })

  test('50 characters, 1000 steps under 200 ms', () => {
    const w = world()
    const agents = Array.from({ length: 50 }, (_, i) => mk(`p${i}`, i % 3 === 0 ? { status: 'idle' } : {}))
    w.set(...agents)
    const s = performance.now()
    for (let i = 0; i < 1000; i++) w.sim.step(STEP)
    const dt = performance.now() - s
    expect(w.sim.characters().length).toBeGreaterThan(5)
    expect(dt).toBeLessThan(200)
  })
})

describe('sibling looks', () => {
  test('same-type subagents get distinct looks and the first keeps the plain name', () => {
    const w = world()
    const p = mk('s')
    const sub = (id: string, t: number): AgentState => ({ ...mk('s'), key: `t:s:${id}`, ref: { provider: 't', sessionId: 's', agentId: id }, agentType: 'general-purpose', parentKey: p.key, startedAt: t })
    w.set(p, sub('a', 1), sub('b', 2))
    w.run(3000)
    const by = Object.fromEntries(w.sim.characters().map((c) => [c.key, c]))
    expect(by['t:s:a']?.look).toBe('general-purpose')
    expect(by['t:s:b']?.look).toBe('general-purpose #2')
  })
})
