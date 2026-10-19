// Browser entry. The only file that touches window, document and location.
import { generateSprite, type Frame, type SpriteSheet } from '@deskmates/sprites'
import { createDemo, createConnection, createMirror, demoSnapshot, isDemo, readToken, stripFragment, type Mirror, type Status } from './index'
import { asPriceTable, DEFAULT_META, formatTokens, pricesNote, type PricesMeta } from './hud/cost'
import { nextTabTarget, shortcutsAction } from './hud/shortcuts'
import { createAnnouncer } from './hud/announce'
import { createLabeler } from './hud/labels'
import { cycleKey, describeTotals, shortDir, summarize, type AgentRow, type Summary } from './hud/summary'
import { createBitmapCache, drawCharacters, drawFloor, drawFurniture, type Ctx2D } from './render/draw'
import { COMPACT_HUD_H, compactCamera, compactFocus, fullCamera, isCompact, screenToView, visibleBoxHeight, type Camera } from './render/compact'
import { fitScale } from './render/fit'
import { drawHud, type ChipHit } from './render/hud'
import { isPointerClick, minBoxView, pickCharacter } from './render/pick'
import { createLoop } from './render/loop'
import { PAL } from './render/palette'
import { defaultLayout, createSim, VIEW_H, VIEW_W, type Sim } from './sim'

const el = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const e = document.getElementById(id)
  if (!(e instanceof type)) throw new Error(`missing #${id}`)
  return e
}
const canvas = el('office', HTMLCanvasElement)
const agentsEl = el('agents', HTMLElement)
const summaryEl = el('summary', HTMLElement)
const liveEl = el('live', HTMLElement)
const statusEl = el('status', HTMLElement)
const badgeEl = el('badge', HTMLElement)
const cardEl = el('card', HTMLElement)
const cardField = (id: string): HTMLElement => el(id, HTMLElement)
const cardFields = {
  name: cardField('card-name'), status: cardField('card-status'), tool: cardField('card-tool'), dir: cardField('card-dir'),
  model: cardField('card-model'), tokens: cardField('card-tokens'), cost: cardField('card-cost'), elapsed: cardField('card-elapsed'),
  subs: cardField('card-subs'),
}
const cardClose = el('card-close', HTMLButtonElement)
const cardContext = el('card-context', HTMLMeterElement)
const cardContextText = cardField('card-context-text')
const cardEvents = el('card-events', HTMLOListElement)
const shortcutsEl = el('shortcuts', HTMLElement)
const shortcutsTitle = el('shortcuts-title', HTMLElement)
const shortcutsClose = el('shortcuts-close', HTMLButtonElement)

const demo = isDemo(location)
const token = readToken(location.hash)
stripFragment(history, location)
const isDemoMode = demo || token === undefined

// ---- data source ------------------------------------------------------------------------------
let mirror: Mirror
const demoGen = isDemoMode ? createDemo() : undefined
if (isDemoMode) {
  mirror = createMirror()
  mirror.applySnapshot(demoSnapshot())
  badgeEl.textContent = 'DEMO'
  badgeEl.title = 'Scripted demo data, not your Claude Code sessions'
  badgeEl.hidden = false
  statusEl.hidden = true
} else if (token !== undefined) {
  const conn = createConnection({
    url: `ws://${location.host}/ws`,
    token,
    WebSocketImpl: WebSocket,
    now: () => Date.now(),
    onStatus: (s: Status) => { statusEl.textContent = s },
    onChange: () => undefined, // state is read every frame
  })
  mirror = conn.mirror
  conn.start()
} else throw new Error('unreachable')

// ---- sim and rendering ------------------------------------------------------------------------
const motion = matchMedia('(prefers-reduced-motion: reduce)')
let showAll = false
const labeler = createLabeler()
const newSim = (): Sim => {
  const s = createSim({ layout: defaultLayout, reducedMotion: motion.matches, labeler })
  s.setShowAll(showAll)
  return s
}
let sim = newSim()
motion.addEventListener('change', () => { sim = newSim() })

const sheets = new Map<string, SpriteSheet>()
const sprites = {
  get(look: string): SpriteSheet {
    let s = sheets.get(look)
    if (!s) {
      s = generateSprite(look)
      sheets.set(look, s)
    }
    return s
  },
}
const makeBitmap = (f: Frame): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = f.width
  c.height = f.height
  c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(f.rgba), f.width, f.height), 0, 0)
  return c
}
const cache = createBitmapCache(makeBitmap)

const off = document.createElement('canvas')
off.width = VIEW_W
off.height = VIEW_H
const offCtx = off.getContext('2d')
const ctx = canvas.getContext('2d')
if (!offCtx || !ctx) throw new Error('canvas 2d unavailable')
const offDraw: Ctx2D = offCtx
// Floor and furniture never change for a given layout: draw them once and blit every frame.
const staticOff = document.createElement('canvas')
staticOff.width = VIEW_W
staticOff.height = VIEW_H
const staticCtx = staticOff.getContext('2d')
if (!staticCtx) throw new Error('canvas 2d unavailable')
const staticDraw: Ctx2D = staticCtx
let staticLayout: typeof defaultLayout | undefined
const renderStatic = (layout: typeof defaultLayout): void => {
  if (staticLayout === layout) return
  staticLayout = layout
  drawFloor(staticDraw)
  drawFurniture(staticDraw, layout)
}

const resize = (): void => {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(document.documentElement.clientWidth * dpr))
  canvas.height = Math.max(1, Math.floor(document.documentElement.clientHeight * dpr))
}
window.addEventListener('resize', resize)
resize()

// ---- DOM mirror and announcements -------------------------------------------------------------
const announcer = createAnnouncer()
let listSig = ''

/** The sr-only list and the alerts both come from the summary, so keyboard selection, list and alerts agree. */
const updateMirror = (sm: Summary): void => {
  const rows = sm.agents.map((a) => `${a.name}: ${a.status}${a.tool ? `, ${a.tool}` : ''}`)
  announcer.observe(sm.agents)
  const sig = rows.join('\n')
  if (sig !== listSig) {
    listSig = sig
    agentsEl.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement('li')
        li.textContent = r
        return li
      }),
    )
  }
}

// ---- selection, agent card, HUD ---------------------------------------------------------------
const HUD_CSS_H = 32
const hudCssH = (cssW: number): number => (isCompact(cssW) ? COMPACT_HUD_H : HUD_CSS_H)
let summary: Summary = { agents: [], needsYou: [], totals: { running: 0, thinking: 0, needsYou: 0, errors: 0, tokens: 0, usd: 0, anyExample: false, partialCost: false, prices: DEFAULT_META } }
let selectedKey: string | undefined
let hoveredKey: string | undefined
let hudHits: ChipHit[] = []
let rawPrices: unknown
let priceTable = asPriceTable(undefined)

const setText = (e: HTMLElement, t: string): void => { if (e.textContent !== t) e.textContent = t }
const cardOpen = (): boolean => !cardEl.hidden
const pricesMeta = (): PricesMeta => ({ source: mirror.pricesSource(), asOf: mirror.pricesAsOf() })
const cardPriceNote = (): string => {
  const m = pricesMeta()
  return m.source === 'example' ? ' (example prices)' : ` (${pricesNote(m)})`
}
let eventsSig: string | undefined
const fillCard = (r: AgentRow): void => {
  const u = r.usage
  setText(cardFields.name, r.name)
  setText(cardFields.status, r.status)
  setText(cardFields.tool, r.tool ?? 'none')
  setText(cardFields.dir, shortDir(r.cwd))
  setText(cardFields.model, r.model ?? 'unknown')
  setText(cardFields.tokens, `${r.tokensLabel} (in ${formatTokens(u.input)}, out ${formatTokens(u.output)}, cache ${formatTokens(u.cacheRead + u.cacheWrite)})`)
  setText(cardFields.cost, `${r.costLabel}${r.cost.known ? cardPriceNote() : ''}`)
  setText(cardFields.elapsed, r.elapsedLabel)
  setText(cardFields.subs, String(r.subagents))
  setText(cardContextText, r.contextLabel)
  const pct = r.contextPct ?? 0
  if (cardContext.value !== pct) cardContext.value = pct
  cardContext.hidden = r.contextPct === undefined // unknown: text only, no misleading empty bar
  cardContext.setAttribute('aria-valuetext', r.contextLabel)
  // The meter announces the value; hide the visible text from AT only while the meter is shown, so it is read once.
  cardContextText.setAttribute('aria-hidden', String(r.contextPct !== undefined))
  const sig = r.recent.join('\n')
  if (sig !== eventsSig) {
    eventsSig = sig
    cardEvents.replaceChildren(...r.recent.map((t) => { const li = document.createElement('li'); li.textContent = t; return li }))
    if (r.recent.length === 0) { const li = document.createElement('li'); li.textContent = 'none yet'; cardEvents.append(li) }
  }
}
/** Hides the card; if focus is inside it, focus goes back to the canvas first so it is never lost. */
const closeCard = (): void => {
  if (cardEl.contains(document.activeElement)) canvas.focus()
  cardEl.hidden = true
}
const select = (key: string | undefined, open = false): void => {
  selectedKey = key
  const r = summary.agents.find((a) => a.key === key)
  if (!r) { closeCard(); return }
  announcer.say(`${r.name}: ${r.status}`)
  if (open) { fillCard(r); cardEl.hidden = false; cardFields.name.focus() }
  else if (cardOpen()) fillCard(r)
}
const refreshSelection = (): void => {
  const r = selectedKey === undefined ? undefined : summary.agents.find((a) => a.key === selectedKey)
  if (!r) { selectedKey = undefined; closeCard(); return }
  if (cardOpen()) fillCard(r)
}
/** Camera for this frame: the whole room letterboxed, or under 640 css px a crop that follows the focused agent. Pointer picking reads the same one. */
const computeCamera = (): Camera => {
  const w = document.documentElement.clientWidth
  const boxH = Math.max(1, document.documentElement.clientHeight - hudCssH(w))
  const dpr = window.devicePixelRatio || 1
  if (!isCompact(w)) return fullCamera(fitScale(VIEW_W, VIEW_H, w, boxH, dpr))
  // The open card is a bottom sheet over the canvas: centre the focus in what is still visible above it.
  const seenH = visibleBoxHeight(document.documentElement.clientHeight, hudCssH(w), cardOpen() ? cardEl.offsetHeight : 0)
  return compactCamera({ w, h: seenH }, compactFocus(sim.characters(), selectedKey, summary.needsYou.map((r) => r.key)), dpr)
}
let camera = computeCamera()

canvas.addEventListener('keydown', (e) => {
  const keys = summary.agents.map((r) => r.key)
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': select(cycleKey(keys, selectedKey, 1)); break
    case 'ArrowLeft': case 'ArrowUp': select(cycleKey(keys, selectedKey, -1)); break
    case 'n': case 'N': {
      const next = cycleKey(summary.needsYou.map((r) => r.key), selectedKey, 1)
      if (next === undefined) announcer.say('No agents need you')
      else select(next)
      break
    }
    case 'a': case 'A':
      showAll = !showAll
      sim.setShowAll(showAll)
      lastRefresh = -Infinity // recount the hidden agents on the next frame
      announcer.say(showAll ? 'Showing all agents' : 'Showing active agents only')
      break
    case 'Enter': case ' ': select(selectedKey ?? keys[0], true); break
    default: return
  }
  e.preventDefault()
})
// ---- shortcuts overlay ------------------------------------------------------------------------
let returnFocus: HTMLElement | undefined
let inerted: HTMLElement[] = [] // only what this overlay made inert is restored
const shortcutsOpen = (): boolean => !shortcutsEl.hidden
/** `?` binds only on the canvas, inside the dialog or card, or with nothing focused; not in other controls. */
const shortcutsFocusOk = (): boolean => {
  const f = document.activeElement
  return f === null || f === document.body || f === document.documentElement || f === canvas || shortcutsEl.contains(f) || cardEl.contains(f)
}
const openShortcuts = (): void => {
  const f = document.activeElement
  returnFocus = f instanceof HTMLElement && f !== document.body ? f : canvas
  shortcutsEl.hidden = false
  shortcutsTitle.focus()
  inerted = [canvas, cardEl].filter((n) => !n.inert)
  for (const n of inerted) n.inert = true
}
const closeShortcuts = (): void => {
  shortcutsEl.hidden = true
  for (const n of inerted) n.inert = false
  inerted = []
  const r = returnFocus
  const back = r && r.isConnected && !r.closest('[hidden]') ? r : canvas
  returnFocus = undefined
  back.focus()
}
shortcutsClose.addEventListener('click', closeShortcuts)
document.addEventListener('keydown', (e) => {
  const act = shortcutsAction(e, { open: shortcutsOpen(), focusOk: shortcutsFocusOk() })
  if (act !== 'none') {
    if (act === 'open') openShortcuts(); else closeShortcuts()
    e.preventDefault()
    e.stopImmediatePropagation()
    return
  }
  if (shortcutsOpen()) {
    if (e.key === 'Tab') { // trap: only the title (tabindex -1) and the Close button live in the dialog
      const t = nextTabTarget<HTMLElement>([shortcutsClose], document.activeElement instanceof HTMLElement && shortcutsEl.contains(document.activeElement) && document.activeElement !== shortcutsTitle ? document.activeElement : undefined, e.shiftKey)
      t?.focus()
      e.preventDefault()
    }
    return
  }
  if (e.key !== 'Escape') return
  if (cardOpen()) { closeCard(); canvas.focus() } else selectedKey = undefined
})
cardClose.addEventListener('click', () => { closeCard(); canvas.focus() })
canvas.addEventListener('pointermove', (e) => {
  const dpr = window.devicePixelRatio || 1
  const b = canvas.getBoundingClientRect()
  const v = screenToView(camera, (e.clientX - b.left) * dpr, (e.clientY - b.top) * dpr)
  hoveredKey = pickCharacter(sim.characters(), v.x, v.y, minBoxView(camera.scale, dpr))
})
canvas.addEventListener('pointerleave', () => { hoveredKey = undefined })
canvas.addEventListener('click', (e) => {
  if (shortcutsOpen() || !isPointerClick(e)) return // Enter can fire a synthetic click at the centre; keydown handles Enter
  const dpr = window.devicePixelRatio || 1
  const b = canvas.getBoundingClientRect()
  const px = (e.clientX - b.left) * dpr
  const py = (e.clientY - b.top) * dpr
  const chip = hudHits.find((h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h)
  if (chip) { select(chip.key, true); return }
  const v = screenToView(camera, px, py)
  const key = pickCharacter(sim.characters(), v.x, v.y, minBoxView(camera.scale, dpr))
  if (key === undefined) { selectedKey = undefined; closeCard() } else select(key, true)
})

// ---- loop -------------------------------------------------------------------------------------
const nowMs = (): number => (isDemoMode ? performance.now() : Date.now())

const REFRESH_MS = 250
let lastSeq = -1
let lastRefresh = -Infinity
let lastTotals = ''

const draw = (): void => {
  const now = nowMs()
  if (demoGen) {
    const events = demoGen.advance(now)
    const first = events[0]
    const last = events.at(-1)
    if (first && last) mirror.applyEvents({ type: 'events', fromSeq: first.seq, toSeq: last.seq, events })
  }
  sim.sync(mirror.state(), now)
  // Summary, DOM mirror and card only change with new events; the timer covers elapsed labels and the ended-agent grace.
  if (mirror.seq() !== lastSeq || now - lastRefresh >= REFRESH_MS) {
    lastSeq = mirror.seq()
    lastRefresh = now
    const raw = mirror.prices()
    if (raw !== rawPrices) { rawPrices = raw; priceTable = asPriceTable(raw) }
    summary = { ...summarize(mirror.state(), priceTable, pricesMeta(), now, labeler), hidden: sim.hiddenCount() }
    updateMirror(summary)
    const totals = describeTotals(summary.totals, summary.hidden)
    if (totals !== lastTotals) { lastTotals = totals; summaryEl.textContent = totals }
    refreshSelection()
  }
  const say = announcer.flush(now)
  if (say !== undefined) liveEl.textContent = say
  renderStatic(defaultLayout)
  offDraw.drawImage(staticOff, 0, 0)
  drawCharacters(offDraw, sim.characters(), sprites, cache, { selectedKey, hoveredKey })
  camera = computeCamera()
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = PAL.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(off, camera.srcX, camera.srcY, camera.srcW, camera.srcH, camera.x, camera.y, camera.w, camera.h)
  // HUD band after the integer-scaled blit, in real pixels, so its text is crisp.
  const dpr = window.devicePixelRatio || 1
  const compact = isCompact(document.documentElement.clientWidth)
  const hudH = Math.round(hudCssH(document.documentElement.clientWidth) * dpr)
  hudHits = drawHud(ctx, summary, { x: 0, y: canvas.height - hudH, w: canvas.width, h: hudH }, dpr, selectedKey, compact)
}

createLoop({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  draw,
  step: (dt) => sim.step(dt),
  isHidden: () => document.hidden,
}).start()
