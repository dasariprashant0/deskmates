import type { AgentState } from '@deskmates/core'
import type { Anim, Dir } from '@deskmates/sprites'
import type { ZoneId } from './layout'
import { zoneForTool } from './zones'

export type Ring = 'working' | 'thinking' | 'needs-you' | 'error' | 'done' | 'idle'

export type CharacterView = {
  key: string
  name: string
  /** Pixel coords of the feet-center in the 320x180 space. */
  x: number
  y: number
  dir: Dir
  anim: Anim
  frame: number
  ring: Ring
  /** Plain text, max 24 chars. */
  bubble?: string
  zone?: ZoneId | 'desk'
  /** 0..1 opacity (reduced-motion teleports and leaving). */
  fade: number
  /** Name tag text (abbreviated, numbered when siblings share a name). Falls back to `name`. */
  short?: string
  /** Full numbered name for the card and lists. */
  full?: string
  /** Sprite seed: the plain name for the first of a name, `name #n` for its siblings. Falls back to `name`. */
  look?: string
}

// Timing constants (ms unless noted).
export const STEP_MS = 33
export const SPEED_PX_PER_S = 48
export const DWELL_MS = 2000
export const LONG_TOOL_MS = 1500
export const ERROR_FLASH_MS = 3000
export const CELEBRATE_MS = 3000
export const BLOCK_MS = 1000
export const SIDESTEP_HOLD_MS = 200
export const LEAVE_FADE_MS = 500
export const TELEPORT_FADE_MS = 150
export const BUBBLE_MAX = 24
export const NAME_MAX = 16
/** An agent without a live status still gets a character this long after its last event. */
export const ACTIVE_WINDOW_MS = 5 * 60_000
/** Most characters at once (desks + hot desks + queue tiles); 'show all' raises it. */
export const MAX_VISIBLE = 16
export const MAX_VISIBLE_ALL = 40

// Sprite frame counts, mirrored from the sprites package (not imported on purpose).
export const FRAME_COUNTS: Record<Anim, number> = {
  walk: 4, idle: 2, sit: 1, type: 2, read: 2, think: 3, celebrate: 4, error: 3,
}
export const FPS: Record<Anim, number> = {
  walk: 8, type: 6, idle: 4, sit: 4, read: 4, think: 4, celebrate: 4, error: 4,
}

export const frameAt = (anim: Anim, ms: number): number =>
  Math.floor((ms / 1000) * FPS[anim]) % FRAME_COUNTS[anim]

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** Plain text, no markup interpretation: control chars become spaces, then cut to BUBBLE_MAX code points. */
export function clipBubble(s: string): string {
  const cps = Array.from(s.replace(CONTROL, ' ').trim())
  return cps.length <= BUBBLE_MAX ? cps.join('') : cps.slice(0, BUBBLE_MAX - 1).join('') + '…'
}

const basename = (p: string | undefined): string => p?.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Working, thinking or waiting on the user: always worth showing. */
export const isLive = (s: AgentState): boolean => s.status === 'working' || s.status === 'thinking' || s.status === 'waiting' || s.attention !== undefined

/** Project folder for a main agent, agentType for a subagent, else the session id's first 6 chars. */
export function deriveName(s: AgentState): string {
  const raw = s.ref.agentId !== undefined ? (s.agentType ?? '') : basename(s.cwd)
  const name = raw.replace(CONTROL, ' ').trim() || s.ref.sessionId.slice(0, 6)
  return Array.from(name).slice(0, NAME_MAX).join('')
}

export type Intent = {
  /** Zone to be in; undefined means stay wherever the agent currently is. */
  zone?: ZoneId | 'desk'
  anim: Anim
  ring: Ring
  bubble?: string
}

const workAnim = (activity: AgentState['activity'], zone: ZoneId | 'desk'): Anim => {
  switch (activity) {
    case 'reading':
    case 'searching':
      return 'read'
    case 'editing':
    case 'typing':
    case 'running':
      return 'type'
    default:
      return zone === 'bookshelf' || zone === 'webwall' ? 'read' : 'type'
  }
}

/** What an agent wants to be doing, from its state at sync-relative time `now`. */
export function intentFor(s: AgentState, now: number, celebrating: boolean): Intent {
  const tool = s.currentTool
  const bubble = tool ? clipBubble(tool.summary) : undefined
  const errorRecent = s.lastError !== undefined && now - s.lastError.at < ERROR_FLASH_MS
  if (s.status === 'waiting' || s.attention) return { zone: 'bell', anim: 'think', ring: 'needs-you', bubble }
  if (s.status === 'error' || errorRecent) return { anim: 'error', ring: 'error' }
  if (s.status === 'done') {
    return celebrating ? { anim: 'celebrate', ring: 'done' } : { zone: 'coffee', anim: 'idle', ring: 'done' }
  }
  if (s.status === 'idle') return { zone: 'coffee', anim: 'idle', ring: 'idle' }
  if (s.status === 'thinking') return { zone: 'desk', anim: 'think', ring: 'thinking' }
  if (!tool) return { zone: 'desk', anim: 'type', ring: 'working' }
  const target = zoneForTool(tool.name)
  const zone = target === 'door' ? 'desk' : target // the parent of an Agent call stays at its desk
  if (zone === 'desk') return { zone: 'desk', anim: 'type', ring: 'working', bubble }
  const long = now - tool.startedAt > LONG_TOOL_MS
  return { zone: long ? zone : undefined, anim: workAnim(s.activity, zone), ring: 'working', bubble }
}
