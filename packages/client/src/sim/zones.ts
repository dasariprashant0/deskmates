import type { Layout, Tile, ZoneId } from './layout'

export type { ZoneId }

const TOOL_ZONES = new Map<string, ZoneId | 'desk'>([
  ['Read', 'bookshelf'],
  ['Grep', 'bookshelf'],
  ['Glob', 'bookshelf'],
  ['Bash', 'terminal'],
  ['Edit', 'whiteboard'],
  ['Write', 'whiteboard'],
  ['NotebookEdit', 'whiteboard'],
  ['WebSearch', 'webwall'],
  ['WebFetch', 'webwall'],
  // The parent of an Agent call stays at its desk; the child walks in through the door.
  ['Agent', 'door'],
  ['TodoWrite', 'desk'],
])

export function zoneForTool(name: string): ZoneId | 'desk' {
  if (name.startsWith('mcp__')) return 'rack'
  return TOOL_ZONES.get(name) ?? 'desk'
}

/** Reserves and releases standing slots per zone for an agent key. Never double-books. */
export class SlotTable {
  private readonly zones: Layout['zones']
  private readonly owners = new Map<ZoneId, (string | undefined)[]>()
  // A key may hold slots in several zones until it releases them.
  private readonly held = new Map<string, { zone: ZoneId; index: number }[]>()

  constructor(layout: Pick<Layout, 'zones'>) {
    this.zones = layout.zones
  }

  private ownersOf(zone: ZoneId): (string | undefined)[] {
    let o = this.owners.get(zone)
    if (!o) {
      o = this.zones[zone].slots.map(() => undefined)
      this.owners.set(zone, o)
    }
    return o
  }

  /** The key's slot in this zone (idempotent), else the first free slot, else undefined (queue at waitTile). */
  reserve(zone: ZoneId, key: string): Tile | undefined {
    const slots = this.zones[zone].slots
    const mine = this.held.get(key) ?? []
    const cur = mine.find((h) => h.zone === zone)
    if (cur) return slots[cur.index]
    const owners = this.ownersOf(zone)
    const index = owners.findIndex((o) => o === undefined)
    if (index < 0) return undefined
    owners[index] = key
    mine.push({ zone, index })
    this.held.set(key, mine)
    return slots[index]
  }

  /** Releases every slot the key holds, or only the one in `zone`. */
  release(key: string, zone?: ZoneId): void {
    const mine = this.held.get(key)
    if (!mine) return
    const keep = mine.filter((h) => {
      if (zone !== undefined && h.zone !== zone) return true
      const o = this.ownersOf(h.zone)
      if (o[h.index] === key) o[h.index] = undefined
      return false
    })
    if (keep.length) this.held.set(key, keep)
    else this.held.delete(key)
  }
}
