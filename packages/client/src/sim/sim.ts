import type { AgentState, OfficeState } from '@deskmates/core'
import type { Anim, Dir } from '@deskmates/sprites'
import {
  ACTIVE_WINDOW_MS, BLOCK_MS, CELEBRATE_MS, DWELL_MS, LEAVE_FADE_MS, MAX_VISIBLE, MAX_VISIBLE_ALL, SIDESTEP_HOLD_MS, SPEED_PX_PER_S, STEP_MS,
  TELEPORT_FADE_MS, deriveName, frameAt, intentFor, isLive,
  type CharacterView, type Intent, type Ring,
} from './character'
import { labelAgents } from '../hud/labels'
import { defaultLayout, TILE, tilePx, type Layout, type Tile, type ZoneId } from './layout'
import { findPath, tileKey } from './path'
import { createRng, type Rng } from './rng'
import { SlotTable } from './zones'

export type SimOptions = {
  layout?: Layout
  reducedMotion?: boolean
  seed?: string
  /** Agents that are not live get a character only this long after their last event. Default ACTIVE_WINDOW_MS. */
  activeWindowMs?: number
  /** Most simultaneous characters. Default MAX_VISIBLE. */
  maxVisible?: number
}
export type Sim = {
  sync(state: OfficeState, nowMs: number): void
  step(dtMs: number): void
  characters(): CharacterView[]
  /** Agents in the state (not ended) that have no character because they are idle, old or over the cap. */
  hiddenCount(): number
  /** true: every agent is eligible and the cap rises to MAX_VISIBLE_ALL; false: back to the options' values. */
  setShowAll(on: boolean): void
}

type Where = ZoneId | 'desk'
type Goal = { id: number; zone: Where; kind: 'slot' | 'wait' | 'desk' | 'door'; tile: Tile }
type Assign = { kind: 'desk' | 'hot' | 'queue'; idx: number }
type Teleport = { phase: 'out' | 'in'; t: number; to: Tile }

type Char = {
  key: string
  order: number
  rng: Rng
  phase: number
  name: string
  short: string
  full: string
  state: AgentState
  spawned: boolean
  tile: Tile
  next: Tile | undefined
  prog: number
  x: number
  y: number
  dir: Dir
  path: Tile[]
  goal: Goal | undefined
  arrivedId: number
  arrivedAt: number
  zone: Where | undefined
  waiting: boolean
  seated: boolean
  assign: Assign
  blockedMs: number
  hold: number
  sidestep: boolean
  planRetryAt: number
  leaving: boolean
  fadeOut: number | undefined
  fadeTotal: number
  doneSince: number | undefined
  tp: Teleport | undefined
  anim: Anim
  animT: number
  frame: number
  ring: Ring
  bubble: string | undefined
}

const PX_PER_STEP = (SPEED_PX_PER_S * STEP_MS) / 1000
const REPLAN_BLOCK_MS = 330
const HALF_TELEPORT = TELEPORT_FADE_MS / 2
const NEIGHBORS: readonly [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]

const same = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y
const isEnded = (a: AgentState): boolean => a.endedAt !== undefined && (a.status === 'done' || a.status === 'error')
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

export function createSim(opts: SimOptions = {}): Sim {
  const layout = opts.layout ?? defaultLayout
  const reduced = opts.reducedMotion ?? false
  const seed = opts.seed ?? 'deskmates'
  const table = new SlotTable(layout)
  const baseWindow = opts.activeWindowMs ?? ACTIVE_WINDOW_MS
  const baseCap = opts.maxVisible ?? MAX_VISIBLE
  let windowMs = baseWindow
  let cap = baseCap
  let hidden = 0

  let chars: Char[] = []
  const byKey = new Map<string, Char>()
  const occ = new Map<string, string>() // tile key -> char key (current tile and claimed next tile)
  const deskOwner: (string | undefined)[] = layout.desks.map(() => undefined)
  const hotOwner: (string | undefined)[] = layout.hotDesks.map(() => undefined)
  const queueOwner: (string | undefined)[] = layout.queue.map(() => undefined)

  let t = 0 // internal clock, advances in STEP_MS sub-steps
  let acc = 0
  let syncNow = 0
  let tSync = 0
  let orderSeq = 0
  let goalSeq = 0

  const effNow = (): number => syncNow + (t - tSync)

  // ---- desk assignment -------------------------------------------------------------------
  const owners = (kind: Assign['kind']): (string | undefined)[] =>
    kind === 'desk' ? deskOwner : kind === 'hot' ? hotOwner : queueOwner

  const assignFor = (key: string): Assign => {
    for (const kind of ['desk', 'hot', 'queue'] as const) {
      const o = owners(kind)
      const idx = o.findIndex((k) => k === undefined)
      if (idx >= 0) {
        o[idx] = key
        return { kind, idx }
      }
    }
    return { kind: 'queue', idx: Math.max(0, queueOwner.length - 1) } // overflow shares the last queue tile
  }
  const freeAssign = (c: Char): void => {
    const o = owners(c.assign.kind)
    if (o[c.assign.idx] === c.key) o[c.assign.idx] = undefined
  }
  const promote = (c: Char): void => {
    if (c.assign.kind !== 'queue') return
    for (const kind of ['desk', 'hot'] as const) {
      const o = owners(kind)
      const idx = o.findIndex((k) => k === undefined)
      if (idx >= 0) {
        freeAssign(c)
        o[idx] = c.key
        c.assign = { kind, idx }
        return
      }
    }
  }
  const deskTile = (c: Char): Tile => {
    const { kind, idx } = c.assign
    const tile = kind === 'desk' ? layout.desks[idx]?.seat : kind === 'hot' ? layout.hotDesks[idx] : layout.queue[idx]
    return tile ?? layout.doorTile
  }
  const facingOf = (c: Char, zone: Where): Dir => {
    if (zone !== 'desk') return layout.zones[zone].facing
    if (c.assign.kind === 'desk') return layout.desks[c.assign.idx]?.facing ?? 'up'
    return c.assign.kind === 'hot' ? 'up' : 'down'
  }

  // ---- occupancy and planning ------------------------------------------------------------
  const release = (tile: Tile, key: string): void => {
    const k = tileKey(tile)
    if (occ.get(k) === key) occ.delete(k)
  }

  const plan = (c: Char): void => {
    const g = c.goal
    if (!g) return
    const from = c.next ?? c.tile
    if (same(from, g.tile)) {
      c.path = []
      return
    }
    const blocked = new Set<string>()
    for (const [k, owner] of occ) if (owner !== c.key) blocked.add(k)
    const p = findPath(layout.walkable, from, g.tile, blocked) ?? findPath(layout.walkable, from, g.tile)
    c.path = p ?? []
    c.planRetryAt = p ? 0 : t + 500
  }

  const setGoal = (c: Char, zone: Where, kind: Goal['kind'], tile: Tile): void => {
    c.goal = { id: ++goalSeq, zone, kind, tile }
    c.zone = undefined
    c.waiting = false
    c.sidestep = false
    c.blockedMs = 0
    c.path = []
    if (!reduced) plan(c)
  }

  const startLeaving = (c: Char): void => {
    if (c.leaving) return
    c.leaving = true
    table.release(c.key)
    freeAssign(c)
    c.zone = undefined
    c.waiting = false
    if (!c.spawned) return
    if (reduced) {
      c.goal = undefined
      c.path = []
      c.fadeOut = TELEPORT_FADE_MS
      c.fadeTotal = TELEPORT_FADE_MS
    } else setGoal(c, 'door', 'door', layout.doorTile)
  }

  const trySpawn = (c: Char): void => {
    const tile = reduced ? deskTile(c) : layout.doorTile
    if (occ.has(tileKey(tile))) return
    occ.set(tileKey(tile), c.key)
    const p = tilePx(tile)
    c.spawned = true
    c.tile = tile
    c.x = p.x
    c.y = p.y
    if (reduced) c.tp = { phase: 'in', t: 0, to: tile }
  }

  const create = (a: AgentState): Char => {
    const rng = createRng(`${seed}:${a.key}`)
    const c: Char = {
      key: a.key, order: orderSeq++, rng, phase: Math.floor(rng.next() * 1000), name: deriveName(a), short: deriveName(a), full: deriveName(a), state: a,
      spawned: false, tile: layout.doorTile, next: undefined, prog: 0, x: 0, y: 0, dir: 'up', path: [],
      goal: undefined, arrivedId: 0, arrivedAt: 0, zone: undefined, waiting: false, seated: false,
      assign: assignFor(a.key), blockedMs: 0, hold: 0, sidestep: false, planRetryAt: 0, leaving: false,
      fadeOut: undefined, fadeTotal: LEAVE_FADE_MS, doneSince: undefined, tp: undefined,
      anim: 'idle', animT: 0, frame: 0, ring: 'idle', bubble: undefined,
    }
    c.animT = c.phase
    chars.push(c)
    byKey.set(c.key, c)
    return c
  }

  const drop = (c: Char): void => {
    release(c.tile, c.key)
    if (c.next) release(c.next, c.key)
    table.release(c.key)
    freeAssign(c)
    byKey.delete(c.key)
  }

  // ---- per-substep logic -----------------------------------------------------------------
  const evaluate = (c: Char): Intent => {
    if (c.state.status === 'done') c.doneSince ??= t
    else c.doneSince = undefined
    const celebrating = c.doneSince !== undefined && t - c.doneSince < CELEBRATE_MS
    return intentFor(c.state, effNow(), celebrating)
  }

  // Tiles waiters must not stand on: they would block the people they are waiting for.
  const noWait = new Set<string>()
  for (const z of Object.values(layout.zones)) for (const sl of z.slots) noWait.add(tileKey(sl))
  for (const d of layout.desks) noWait.add(tileKey(d.seat))
  for (const h of layout.hotDesks) noWait.add(tileKey(h))
  noWait.add(tileKey(layout.doorTile))

  /** The zone's waitTile, or the nearest free tile around it when others are already queueing there. */
  const waitSpot = (c: Char, zone: ZoneId): Tile => {
    const home = layout.zones[zone].waitTile
    const g = c.goal
    if (g && g.zone === zone && g.kind === 'wait') {
      const o = occ.get(tileKey(g.tile))
      if (o === undefined || o === c.key) return g.tile
    }
    const seen = new Set<string>([tileKey(home)])
    const queue: Tile[] = [home]
    for (let i = 0; i < queue.length && i < 200; i++) {
      const cur = queue[i] as Tile
      const o = occ.get(tileKey(cur))
      if ((o === undefined || o === c.key) && (i === 0 || !noWait.has(tileKey(cur)))) return cur
      for (const [dx, dy] of NEIGHBORS) {
        const n = { x: cur.x + dx, y: cur.y + dy }
        const nk = tileKey(n)
        if (seen.has(nk) || layout.walkable[n.y]?.[n.x] !== true) continue
        seen.add(nk)
        queue.push(n)
      }
    }
    return home
  }

  const updateGoal = (c: Char, it: Intent): void => {
    if (c.leaving) return
    const cur = c.goal?.zone
    let want: Where = !c.seated ? 'desk' : (it.zone ?? cur ?? 'desk')
    if (c.zone !== undefined && want !== c.zone && t - c.arrivedAt < DWELL_MS) want = c.zone
    let kind: Goal['kind']
    let tile: Tile
    if (want === 'desk') {
      table.release(c.key)
      promote(c)
      kind = 'desk'
      tile = deskTile(c)
    } else {
      if (cur !== want) table.release(c.key)
      const slot = table.reserve(want, c.key)
      kind = slot ? 'slot' : 'wait'
      tile = slot ?? waitSpot(c, want)
    }
    const g = c.goal
    if (!g || g.zone !== want || g.kind !== kind || !same(g.tile, tile)) setGoal(c, want, kind, tile)
  }

  const doSidestep = (who: Char, other: Char): void => {
    const avoid = other.next ?? other.path[0]
    const free: Tile[] = []
    for (const [dx, dy] of NEIGHBORS) {
      const n = { x: who.tile.x + dx, y: who.tile.y + dy }
      if (layout.walkable[n.y]?.[n.x] !== true || occ.has(tileKey(n))) continue
      if (avoid && same(avoid, n)) continue
      free.push(n)
    }
    const pick = who.rng.pick(free)
    if (!pick) {
      who.blockedMs = BLOCK_MS - 300 // nowhere to go: look again shortly
      return
    }
    who.path = [pick]
    who.sidestep = true
    who.blockedMs = 0
  }

  const resolveBlock = (c: Char, ownerKey: string): void => {
    const b = byKey.get(ownerKey)
    if (!b) {
      c.blockedMs = 0
      return
    }
    const loser = c.order > b.order ? c : b
    if (loser === c) doSidestep(c, b)
    else if (!b.next && b.path.length === 0 && b.hold <= 0 && !b.tp) doSidestep(b, c)
  }

  const move = (c: Char): void => {
    if (c.next) {
      c.prog += PX_PER_STEP
      if (c.prog >= TILE) {
        c.prog -= TILE
        release(c.tile, c.key)
        c.tile = c.next
        c.next = undefined
        if (c.sidestep && c.path.length === 0) {
          c.sidestep = false
          c.hold = SIDESTEP_HOLD_MS
        }
      }
    }
    if (!c.next) {
      if (c.hold > 0) {
        c.hold -= STEP_MS
        c.prog = 0
      } else {
        const nt = c.path[0]
        if (!nt) {
          c.blockedMs = 0
          c.prog = 0
        } else {
          const owner = occ.get(tileKey(nt))
          if (owner === undefined || owner === c.key) {
            occ.set(tileKey(nt), c.key)
            c.next = nt
            c.path.shift()
            c.blockedMs = 0
            c.dir = nt.x > c.tile.x ? 'right' : nt.x < c.tile.x ? 'left' : nt.y > c.tile.y ? 'down' : 'up'
          } else {
            c.prog = 0
            c.blockedMs += STEP_MS
            // Held up for a third of a second: look for a way around the blocker before waiting longer.
            if (c.blockedMs >= REPLAN_BLOCK_MS && c.blockedMs < REPLAN_BLOCK_MS + STEP_MS) plan(c)
            if (c.blockedMs > BLOCK_MS) resolveBlock(c, owner)
          }
        }
      }
    }
    const a = tilePx(c.tile)
    if (c.next) {
      const b = tilePx(c.next)
      const f = c.prog / TILE
      c.x = a.x + (b.x - a.x) * f
      c.y = a.y + (b.y - a.y) * f
    } else {
      c.x = a.x
      c.y = a.y
    }
  }

  const moveReduced = (c: Char): void => {
    const tp = c.tp
    if (tp) {
      tp.t += STEP_MS
      if (tp.phase === 'out' && tp.t >= HALF_TELEPORT) {
        const p = tilePx(tp.to)
        c.x = p.x
        c.y = p.y
        c.tp = { phase: 'in', t: 0, to: tp.to }
      } else if (tp.phase === 'in' && tp.t >= HALF_TELEPORT) c.tp = undefined
      return
    }
    const g = c.goal
    if (!g || same(c.tile, g.tile) || occ.has(tileKey(g.tile))) return
    release(c.tile, c.key)
    occ.set(tileKey(g.tile), c.key)
    c.tile = g.tile
    c.tp = { phase: 'out', t: 0, to: g.tile }
  }

  const checkArrive = (c: Char): void => {
    const g = c.goal
    if (!g || c.arrivedId === g.id) return
    if (c.next || c.tp || c.path.length > 0 || !same(c.tile, g.tile)) return
    c.arrivedId = g.id
    c.arrivedAt = t
    if (g.kind === 'door') {
      c.fadeOut = LEAVE_FADE_MS
      c.fadeTotal = LEAVE_FADE_MS
    } else if (g.kind === 'wait') {
      c.waiting = true
    } else {
      c.zone = g.zone
      c.dir = facingOf(c, g.zone)
      if (g.kind === 'desk' && c.assign.kind !== 'queue') c.seated = true
    }
  }

  const animate = (c: Char, it: Intent): void => {
    let anim: Anim = it.anim
    let bubble = it.bubble
    if (c.leaving) anim = !reduced && c.next ? 'walk' : 'idle'
    else if (c.waiting) {
      anim = 'idle'
      bubble = '...'
    } else if (!reduced) {
      if (c.next) anim = 'walk'
      else if (c.goal && !same(c.tile, c.goal.tile)) anim = 'idle'
    }
    if (anim !== c.anim) {
      c.anim = anim
      c.animT = c.phase
    } else c.animT += STEP_MS
    c.frame = reduced ? 0 : frameAt(anim, c.animT)
    c.ring = it.ring
    c.bubble = bubble
  }

  const substep = (): void => {
    t += STEP_MS
    for (const c of chars) if (!c.spawned && !c.leaving) trySpawn(c)
    let dropped = false
    for (const c of chars) {
      if (!c.spawned) continue
      const it = evaluate(c)
      if (c.fadeOut === undefined) {
        updateGoal(c, it)
        if (reduced) moveReduced(c)
        else {
          if (!c.next && c.path.length === 0 && c.goal && !same(c.tile, c.goal.tile) && t >= c.planRetryAt) plan(c)
          move(c)
        }
        checkArrive(c)
      } else {
        c.fadeOut -= STEP_MS
        if (c.fadeOut <= 0) dropped = true
      }
      animate(c, it)
    }
    if (dropped) {
      chars = chars.filter((c) => {
        const gone = c.fadeOut !== undefined && c.fadeOut <= 0
        if (gone) drop(c)
        return !gone
      })
    }
  }

  const view = (c: Char): CharacterView => {
    const fade =
      c.fadeOut !== undefined
        ? clamp01(c.fadeOut / c.fadeTotal)
        : c.tp
          ? clamp01(c.tp.phase === 'out' ? 1 - c.tp.t / HALF_TELEPORT : c.tp.t / HALF_TELEPORT)
          : 1
    const v: CharacterView = {
      key: c.key, name: c.name, short: c.short, full: c.full, x: c.x, y: c.y, dir: c.dir, anim: c.anim, frame: c.frame, ring: c.ring, fade,
    }
    if (c.bubble !== undefined) v.bubble = c.bubble
    if (c.zone !== undefined) v.zone = c.zone
    return v
  }

  return {
    sync(state, nowMs) {
      syncNow = nowMs
      tSync = t
      const labels = labelAgents(state)
      const seen = new Set<string>()
      const cands: AgentState[] = []
      let nonEnded = 0
      // core reduce only ever adds an agent together with its `order` entry, so `order` covers every agent.
      for (const key of state.order) {
        const a = state.agents[key]
        if (!a || seen.has(key)) continue
        seen.add(key)
        const c = byKey.get(key)
        if (c) {
          c.state = a
          c.name = deriveName(a)
          const l = labels.get(key)
          c.short = l?.short ?? c.name
          c.full = l?.full ?? c.name
        }
        if (isEnded(a)) {
          if (c) startLeaving(c)
          continue
        }
        nonEnded++
        if (isLive(a) || nowMs - a.lastEventAt <= windowMs) cands.push(a)
        else if (c) startLeaving(c)
      }
      for (const c of chars) if (!seen.has(c.key)) startLeaving(c)
      // Live agents first, then the most recent; the sort is stable so ties keep state order.
      cands.sort((x, y) => Number(isLive(y)) - Number(isLive(x)) || y.lastEventAt - x.lastEventAt)
      let kept = 0
      for (const a of cands) {
        const c = byKey.get(a.key)
        if (c?.leaving) continue
        if (kept >= cap) {
          if (c) startLeaving(c)
          continue
        }
        kept++
        if (!c && chars.length < cap) {
          const l = labels.get(a.key)
          const n = create(a)
          n.short = l?.short ?? n.name
          n.full = l?.full ?? n.name
        }
      }
      for (const c of chars) if (!c.spawned && !c.leaving) trySpawn(c)
      // Clean up anything that left before it ever spawned.
      if (chars.some((c) => c.leaving && !c.spawned)) {
        chars = chars.filter((c) => {
          const gone = c.leaving && !c.spawned
          if (gone) drop(c)
          return !gone
        })
      }
      hidden = Math.max(0, nonEnded - chars.reduce((n, c) => n + (c.leaving ? 0 : 1), 0))
    },
    step(dtMs) {
      acc += dtMs
      while (acc >= STEP_MS) {
        acc -= STEP_MS
        substep()
      }
    },
    characters() {
      return chars.filter((c) => c.spawned).map(view)
    },
    hiddenCount: () => hidden,
    setShowAll(on) {
      windowMs = on ? Infinity : baseWindow
      cap = on ? Math.max(baseCap, MAX_VISIBLE_ALL) : baseCap
    },
  }
}
