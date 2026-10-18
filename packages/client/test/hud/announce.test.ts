import { describe, expect, test } from 'vitest'
import { createAnnouncer, GAP_MS } from '../../src/hud/announce'

const row = (key: string, status: string, name = key) => ({ key, name, status })

describe('announcer', () => {
  test('first frame seeds silently: already-waiting agents are not announced', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'needs you'), row('b', 'error')])
    expect(a.flush(0)).toBeUndefined()
    a.observe([row('a', 'needs you'), row('b', 'error')])
    expect(a.flush(10_000)).toBeUndefined()
  })
  test('transition into error announces, with the status word for needs-you', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'working'), row('b', 'working')])
    a.observe([row('a', 'error', 'ada'), row('b', 'maybe waiting', 'bob')])
    expect(a.flush(0)).toBe('ada hit an error. bob maybe waiting')
  })
  test('needs you stays "needs you"', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'working')])
    a.observe([row('a', 'needs you')])
    expect(a.flush(0)).toBe('a needs you')
  })
  test('an agent appearing after the first frame already in error is announced', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'working')])
    a.observe([row('a', 'working'), row('b', 'error')])
    expect(a.flush(0)).toBe('b hit an error')
  })
  test('queued messages are concatenated, not overwritten, and rate limited', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'working'), row('b', 'working')])
    a.say('first')
    expect(a.flush(0)).toBe('first')
    a.observe([row('a', 'error'), row('b', 'working')])
    a.say('sel')
    expect(a.flush(GAP_MS - 1)).toBeUndefined()
    a.observe([row('a', 'error'), row('b', 'needs you')])
    expect(a.flush(GAP_MS)).toBe('a hit an error. sel. b needs you')
    expect(a.flush(GAP_MS * 5)).toBeUndefined()
  })
  test('an agent that leaves and returns is re-announced', () => {
    const a = createAnnouncer()
    a.observe([row('a', 'working')])
    a.observe([row('a', 'error')])
    a.flush(0)
    a.observe([])
    a.observe([row('a', 'error')])
    expect(a.flush(GAP_MS)).toBe('a hit an error')
  })
})
