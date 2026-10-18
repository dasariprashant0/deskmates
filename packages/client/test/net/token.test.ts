import { describe, expect, test, vi } from 'vitest'
import { isDemo, readToken, stripFragment } from '../../src/net'

const T = 'A'.repeat(32)
const T2 = 'abcDEF012_-'.repeat(5) // 55 chars

describe('readToken', () => {
  test.each([
    ['#t=' + T, T],
    ['#t=' + T2, T2],
    ['#t=' + T + '&demo', T],
    ['#demo&t=' + T, T],
    ['#t=' + 'a'.repeat(128), 'a'.repeat(128)],
    ['#t=' + 'a'.repeat(31), undefined],
    ['#t=' + 'a'.repeat(129), undefined],
    ['#t=' + 'a'.repeat(31) + '!', undefined],
    ['#t=' + T + '%20', undefined],
    ['#t=', undefined],
    ['', undefined],
    ['#', undefined],
    ['#demo', undefined],
    ['t=' + T, T],
  ] as const)('%s', (hash, want) => {
    expect(readToken(hash)).toBe(want)
  })
})

describe('isDemo', () => {
  test.each([
    [{ search: '?demo=1', hash: '' }, true],
    [{ search: '?x=2&demo=1', hash: '' }, true],
    [{ search: '', hash: '#demo' }, true],
    [{ search: '', hash: '#t=' + T + '&demo' }, true],
    [{ search: '?demo=0', hash: '' }, false],
    [{ search: '', hash: '#t=' + T }, false],
    [{ search: '', hash: '' }, false],
  ])('%j', (loc, want) => {
    expect(isDemo(loc)).toBe(want)
  })
})

describe('stripFragment', () => {
  test('replaceState once with pathname+search, no fragment', () => {
    const replaceState = vi.fn()
    stripFragment({ replaceState }, { pathname: '/app', search: '?a=1' })
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?a=1')
  })
})
