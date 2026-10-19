import { describe, expect, test } from 'vitest'
import { nextTabTarget, shortcutsAction, type KeyInfo, type ShortcutsState } from '../../src/hud/shortcuts'

const K = (key: string, o: Partial<KeyInfo> = {}): KeyInfo => ({ key, shiftKey: key === '?', ...o })
const S = (o: Partial<ShortcutsState> = {}): ShortcutsState => ({ open: false, focusOk: true, ...o })

describe('shortcutsAction', () => {
  test('? opens when closed', () => {
    expect(shortcutsAction(K('?'), S())).toBe('open')
    expect(shortcutsAction(K('?', { shiftKey: false }), S())).toBe('open') // layouts that report ? without shift
  })
  test('Shift+/ reported as "/" (synthesised keys) also opens', () => {
    expect(shortcutsAction(K('/', { shiftKey: true }), S())).toBe('open')
    expect(shortcutsAction(K('/', { shiftKey: false }), S())).toBe('none')
  })
  test('? opens even while the agent card is open', () => {
    expect(shortcutsAction(K('?'), S({ cardOpen: true }))).toBe('open')
  })
  test('? and Escape close when open', () => {
    expect(shortcutsAction(K('?'), S({ open: true }))).toBe('close')
    expect(shortcutsAction(K('Escape'), S({ open: true }))).toBe('close')
  })
  test('Escape does nothing here when closed (card handler owns it)', () => {
    expect(shortcutsAction(K('Escape'), S())).toBe('none')
  })
  test('ignored when focus is in another control', () => {
    expect(shortcutsAction(K('?'), S({ focusOk: false }))).toBe('none')
  })
  test.each(['ctrlKey', 'metaKey', 'altKey'] as const)('ignored with %s', (m) => {
    expect(shortcutsAction(K('?', { [m]: true }), S())).toBe('none')
    expect(shortcutsAction(K('Escape', { [m]: true }), S({ open: true }))).toBe('none')
  })
  test('ignored while composing', () => {
    expect(shortcutsAction(K('?', { isComposing: true }), S())).toBe('none')
    expect(shortcutsAction(K('Escape', { isComposing: true }), S({ open: true }))).toBe('none')
  })
  test('ignored on key repeat (no open/close flicker), but Escape repeat still closes', () => {
    expect(shortcutsAction(K('?', { repeat: true }), S())).toBe('none')
    expect(shortcutsAction(K('?', { repeat: true }), S({ open: true }))).toBe('none')
    expect(shortcutsAction(K('Escape', { repeat: true }), S({ open: true }))).toBe('close')
  })
  test('other keys are none', () => {
    expect(shortcutsAction(K('n'), S())).toBe('none')
  })
})

describe('nextTabTarget', () => {
  const f = ['a', 'b', 'c']
  test('wraps forward and backward', () => {
    expect(nextTabTarget(f, 'c', false)).toBe('a')
    expect(nextTabTarget(f, 'a', true)).toBe('c')
    expect(nextTabTarget(f, 'a', false)).toBe('b')
  })
  test('focus outside the list (e.g. dialog title) goes to first or last', () => {
    expect(nextTabTarget(f, undefined, false)).toBe('a')
    expect(nextTabTarget(f, undefined, true)).toBe('c')
  })
  test('empty list yields undefined', () => {
    expect(nextTabTarget([], undefined, false)).toBeUndefined()
  })
})
