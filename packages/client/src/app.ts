// Browser entry. The only file that touches window, document and location.
import type { AgentState } from '@deskmates/core'
import { generateSprite, type Frame, type SpriteSheet } from '@deskmates/sprites'
import { createDemo, createConnection, createMirror, demoSnapshot, isDemo, readToken, stripFragment, type Mirror, type Status } from './index'
import { asPriceTable, formatTokens } from './hud/cost'
import { cycleKey, shortDir, summarize, type AgentRow, type Summary } from './hud/summary'
import { createBitmapCache, drawScene, type Ctx2D } from './render/draw'
import { fitScale } from './render/fit'
import { drawHud, type ChipHit } from './render/hud'
import { pickCharacter, toView } from './render/pick'
import { createLoop } from './render/loop'
import { PAL } from './render/palette'
import { deriveName, defaultLayout, createSim, VIEW_H, VIEW_W, type Sim } from './sim'

const el = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const e = document.getElementById(id)
  if (!(e instanceof type)) throw new Error(`missing #${id}`)
  return e
}
const canvas = el('office', HTMLCanvasElement)
const agentsEl = el('agents', HTMLElement)
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
const newSim = (): Sim => createSim({ layout: defaultLayout, reducedMotion: motion.matches })
let sim = newSim()
motion.addEventListener('change', () => { sim = newSim() })

const sheets = new Map<string, SpriteSheet>()
const sprites = {
  get(name: string): SpriteSheet {
    let s = sheets.get(name)
    if (!s) {
      s = generateSprite(name)
      sheets.set(name, s)
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

const resize = (): void => {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(document.documentElement.clientWidth * dpr))
  canvas.height = Math.max(1, Math.floor(document.documentElement.clientHeight * dpr))
}
window.addEventListener('resize', resize)
resize()

// ---- DOM mirror and announcements -------------------------------------------------------------
const wording = (a: AgentState): string => (a.status === 'waiting' || a.attention ? 'needs you' : a.status)
const ended = (a: AgentState): boolean => a.endedAt !== undefined && (a.status === 'done' || a.status === 'error')
const prev = new Map<string, string>()
let listSig = ''
let pending: string | undefined
let lastAnnounce = -Infinity

const updateMirror = (now: number): void => {
  const st = mirror.state()
  const rows: string[] = []
  const alerts: string[] = []
  const seen = new Set<string>()
  for (const key of st.order) {
    const a = st.agents[key]
    if (!a || ended(a) || seen.has(key)) continue
    seen.add(key)
    const w = wording(a)
    rows.push(`${deriveName(a)}: ${w}${a.currentTool ? `, ${a.currentTool.summary}` : ''}`)
    const before = prev.get(key)
    if (before !== w && (w === 'needs you' || w === 'error')) alerts.push(`${deriveName(a)} ${w === 'error' ? 'hit an error' : 'needs you'}`)
    prev.set(key, w)
  }
  for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k)
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
  if (alerts.length > 0) pending = alerts.join('. ')
  if (pending !== undefined && now - lastAnnounce >= 2000) {
    liveEl.textContent = pending
    pending = undefined
    lastAnnounce = now
  }
}

// ---- selection, agent card, HUD ---------------------------------------------------------------
const HUD_CSS_H = 32
let summary: Summary = { agents: [], needsYou: [], totals: { running: 0, thinking: 0, needsYou: 0, errors: 0, tokens: 0, usd: 0, anyExample: false, partialCost: false } }
let selectedKey: string | undefined
let hudHits: ChipHit[] = []
let rawPrices: unknown
let priceTable = asPriceTable(undefined)

const setText = (e: HTMLElement, t: string): void => { if (e.textContent !== t) e.textContent = t }
const cardOpen = (): boolean => !cardEl.hidden
const fillCard = (r: AgentRow): void => {
  const u = r.usage
  setText(cardFields.name, r.name)
  setText(cardFields.status, r.status)
  setText(cardFields.tool, r.tool ?? 'none')
  setText(cardFields.dir, shortDir(r.cwd))
  setText(cardFields.model, r.model ?? 'unknown')
  setText(cardFields.tokens, `${r.tokensLabel} (in ${formatTokens(u.input)}, out ${formatTokens(u.output)}, cache ${formatTokens(u.cacheRead + u.cacheWrite)})`)
  setText(cardFields.cost, `${r.costLabel}${r.cost.known && mirror.pricesAreExample() ? ' (example prices)' : ''}`)
  setText(cardFields.elapsed, r.elapsedLabel)
  setText(cardFields.subs, String(r.subagents))
}
const closeCard = (): void => { cardEl.hidden = true }
const select = (key: string | undefined, open = false): void => {
  selectedKey = key
  const r = summary.agents.find((a) => a.key === key)
  if (!r) { closeCard(); return }
  liveEl.textContent = `${r.name}: ${r.status}`
  if (open) { fillCard(r); cardEl.hidden = false }
  else if (cardOpen()) fillCard(r)
}
const refreshSelection = (): void => {
  const r = selectedKey === undefined ? undefined : summary.agents.find((a) => a.key === selectedKey)
  if (!r) { selectedKey = undefined; closeCard(); return }
  if (cardOpen()) fillCard(r)
}
const currentFit = () => fitScale(VIEW_W, VIEW_H, document.documentElement.clientWidth, Math.max(1, document.documentElement.clientHeight - HUD_CSS_H), window.devicePixelRatio || 1)

canvas.addEventListener('keydown', (e) => {
  const keys = summary.agents.map((r) => r.key)
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': select(cycleKey(keys, selectedKey, 1)); break
    case 'ArrowLeft': case 'ArrowUp': select(cycleKey(keys, selectedKey, -1)); break
    case 'n': case 'N': select(cycleKey(summary.needsYou.map((r) => r.key), selectedKey, 1)); break
    case 'Enter': case ' ': select(selectedKey ?? keys[0], true); break
    default: return
  }
  e.preventDefault()
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (cardOpen()) { closeCard(); canvas.focus() } else selectedKey = undefined
})
cardClose.addEventListener('click', () => { closeCard(); canvas.focus() })
canvas.addEventListener('click', (e) => {
  const dpr = window.devicePixelRatio || 1
  const b = canvas.getBoundingClientRect()
  const px = (e.clientX - b.left) * dpr
  const py = (e.clientY - b.top) * dpr
  const chip = hudHits.find((h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h)
  if (chip) { select(chip.key, true); return }
  const v = toView(currentFit(), px, py)
  const key = pickCharacter(sim.characters(), v.x, v.y)
  if (key === undefined) { selectedKey = undefined; closeCard() } else select(key, true)
})

// ---- loop -------------------------------------------------------------------------------------
const nowMs = (): number => (isDemoMode ? performance.now() : Date.now())

const draw = (): void => {
  const now = nowMs()
  if (demoGen) {
    const events = demoGen.advance(now)
    const first = events[0]
    const last = events.at(-1)
    if (first && last) mirror.applyEvents({ type: 'events', fromSeq: first.seq, toSeq: last.seq, events })
  }
  sim.sync(mirror.state(), now)
  updateMirror(now)
  const raw = mirror.prices()
  if (raw !== rawPrices) { rawPrices = raw; priceTable = asPriceTable(raw) }
  summary = summarize(mirror.state(), priceTable, mirror.pricesAreExample(), now)
  refreshSelection()
  drawScene(offDraw, defaultLayout, sim.characters(), sprites, cache, performance.now(), { reducedMotion: motion.matches, selectedKey })
  const f = currentFit()
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = PAL.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(off, 0, 0, VIEW_W, VIEW_H, f.x, f.y, f.w, f.h)
  // HUD band after the integer-scaled blit, in real pixels, so its text is crisp.
  const dpr = window.devicePixelRatio || 1
  const hudH = Math.round(HUD_CSS_H * dpr)
  hudHits = drawHud(ctx, summary, { x: 0, y: canvas.height - hudH, w: canvas.width, h: hudH }, dpr, selectedKey)
}

createLoop({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  draw,
  step: (dt) => sim.step(dt),
  isHidden: () => document.hidden,
}).start()
