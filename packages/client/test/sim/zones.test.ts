import { describe, expect, test } from 'vitest'
import { defaultLayout } from '../../src/sim/layout'
import { SlotTable, zoneForTool } from '../../src/sim/zones'
import { createRng, hashString } from '../../src/sim/rng'

describe('zoneForTool', () => {
  const table: [string, string][] = [
    ['Read', 'bookshelf'], ['Grep', 'bookshelf'], ['Glob', 'bookshelf'],
    ['Bash', 'terminal'],
    ['Edit', 'whiteboard'], ['Write', 'whiteboard'], ['NotebookEdit', 'whiteboard'],
    ['WebSearch', 'webwall'], ['WebFetch', 'webwall'],
    ['mcp__github__create_issue', 'rack'], ['mcp__x__y', 'rack'], ['mcp__', 'rack'],
    ['Agent', 'door'],
    ['TodoWrite', 'desk'], ['SomethingNew', 'desk'], ['', 'desk'], ['constructor', 'desk'], ['read', 'desk'],
  ]
  test.each(table)('%s -> %s', (name, zone) => expect(zoneForTool(name)).toBe(zone))
})

describe('SlotTable', () => {
  const zone = defaultLayout.zones.bell // 2 slots

  test('hands out first free slot in order and is idempotent per key', () => {
    const t = new SlotTable(defaultLayout)
    expect(t.reserve('bell', 'a')).toEqual(zone.slots[0])
    expect(t.reserve('bell', 'b')).toEqual(zone.slots[1])
    expect(t.reserve('bell', 'a')).toEqual(zone.slots[0])
  })

  test('never double-books: full zone returns undefined', () => {
    const t = new SlotTable(defaultLayout)
    t.reserve('bell', 'a')
    t.reserve('bell', 'b')
    expect(t.reserve('bell', 'c')).toBeUndefined()
    expect(t.reserve('bell', 'c')).toBeUndefined()
  })

  test('release frees the slot for the next key; first free slot is reused', () => {
    const t = new SlotTable(defaultLayout)
    t.reserve('bell', 'a')
    t.reserve('bell', 'b')
    t.release('a')
    expect(t.reserve('bell', 'c')).toEqual(zone.slots[0])
    expect(t.reserve('bell', 'a')).toBeUndefined()
  })

  test('zones are independent and release can target one zone', () => {
    const t = new SlotTable(defaultLayout)
    t.reserve('bell', 'a')
    t.reserve('coffee', 'a')
    t.release('a', 'bell')
    expect(t.reserve('bell', 'b')).toEqual(zone.slots[0])
    expect(t.reserve('coffee', 'a')).toEqual(defaultLayout.zones.coffee.slots[0])
    t.release('a')
    t.release('a') // no-op
    expect(t.reserve('coffee', 'z')).toEqual(defaultLayout.zones.coffee.slots[0])
  })
})

describe('rng', () => {
  test('same seed gives the same sequence in [0,1); different seed differs', () => {
    const a = createRng('x'), b = createRng('x'), c = createRng('y')
    const sa = Array.from({ length: 20 }, () => a.next())
    expect(sa).toEqual(Array.from({ length: 20 }, () => b.next()))
    expect(sa).not.toEqual(Array.from({ length: 20 }, () => c.next()))
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true)
  })
  test('pick returns an element; undefined for empty', () => {
    const r = createRng('p')
    for (let i = 0; i < 20; i++) expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']))
    expect(r.pick([])).toBeUndefined()
  })
  test('hashString is stable and spreads', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })
})
