export type KeyInfo = { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean }
/** open: overlay is open. focusOk: focus is on the canvas, inside the dialog or card, or on nothing (not another control). */
export type ShortcutsState = { open: boolean; focusOk: boolean; cardOpen?: boolean }

/** What a keydown means for the shortcuts overlay. The overlay is a modal above the card, so it closes first. */
export function shortcutsAction(e: KeyInfo, s: ShortcutsState): 'open' | 'close' | 'none' {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return 'none'
  if (e.key === 'Escape') return s.open ? 'close' : 'none'
  // Some key tools send Shift+/ as key '/' with shiftKey set.
  if (e.key !== '?' && !(e.key === '/' && e.shiftKey)) return 'none'
  if (e.repeat) return 'none'
  return s.open ? 'close' : s.focusOk ? 'open' : 'none'
}

/** Focus trap: the id to focus on Tab / Shift+Tab; wraps; focus outside the list goes to the first or last. */
export function nextTabTarget<T>(focusables: readonly T[], current: T | undefined, back: boolean): T | undefined {
  if (focusables.length === 0) return undefined
  const i = current === undefined ? -1 : focusables.indexOf(current)
  if (i < 0) return back ? focusables[focusables.length - 1] : focusables[0]
  return focusables[(i + (back ? -1 : 1) + focusables.length) % focusables.length]
}
