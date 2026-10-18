import type { Summary, Totals } from '../hud/summary'
import { formatCost, formatTokens } from '../hud/cost'
import { measure, type Ctx2D } from './draw'
import { HUD, RING_COLOR } from './palette'

export type Box = { x: number; y: number; w: number; h: number }
export type ChipHit = { key: string; x: number; y: number; w: number; h: number }

export const MAX_CHIPS = 3
const FONT = 'ui-monospace, Menlo, Consolas, monospace'
const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s)

type Kind = 'working' | 'thinking' | 'needs' | 'error'
/** Small shapes next to the labels: filled square, outlined square, diamond, cross. Colour only decorates. */
function marker(c: Ctx2D, kind: Kind, x: number, cy: number, u: number): void {
  const s = Math.round(9 * u)
  const y = Math.round(cy - s / 2)
  const color = { working: RING_COLOR.working, thinking: RING_COLOR.thinking, needs: RING_COLOR['needs-you'], error: RING_COLOR.error }[kind]
  c.fillStyle = color
  c.strokeStyle = color
  c.lineWidth = Math.max(1, Math.round(1.5 * u))
  c.setLineDash([])
  if (kind === 'working') c.fillRect(x, y, s, s)
  else if (kind === 'thinking') c.strokeRect(x, y, s, s)
  else {
    c.beginPath()
    if (kind === 'needs') {
      c.moveTo(x + s / 2, y); c.lineTo(x + s, y + s / 2); c.lineTo(x + s / 2, y + s); c.lineTo(x, y + s / 2); c.lineTo(x + s / 2, y)
    } else {
      c.moveTo(x, y); c.lineTo(x + s, y + s); c.moveTo(x + s, y); c.lineTo(x, y + s)
    }
    c.stroke()
  }
}

type Item = { kind?: Kind; text: string; color: string; lead: number }
type Level = 0 | 1 | 2

/**
 * The stats row at three widths: 0 full words, 1 abbreviated counts ('2w 1t 1! 0x') with tokens, 2 counts and cost only.
 * Errors and cost are in every level.
 */
function items(t: Totals, level: Level, u: number): Item[] {
  const counts: [Kind, number, string, string][] = [['working', t.running, 'working', 'w'], ['thinking', t.thinking, 'thinking', 't'], ['needs', t.needsYou, 'needs you', '!'], ['error', t.errors, 'errors', 'x']]
  const out: Item[] = counts.map(([kind, n, long, short]) => ({ kind, text: level === 0 ? `${n} ${long}` : `${n}${short}`, color: HUD.text, lead: 0 }))
  if (level < 2) out.push({ text: `${formatTokens(t.tokens)}${level === 0 ? ' tokens' : ' tok'}`, color: HUD.text, lead: 0 })
  out.push({ text: `${level === 0 ? 'cost ' : ''}${formatCost({ usd: t.usd, known: true })}${t.partialCost ? '+' : ''}`, color: HUD.text, lead: 0 })
  if (t.anyExample) out.push({ text: level === 0 ? 'example prices' : '(ex)', color: HUD.dim, lead: Math.round(6 * u) })
  return out
}

/**
 * Bottom HUD band, drawn in real device pixels (crisp text). `unit` is the device pixel ratio.
 * Returns the hit rects of the needs-you chips it drew. Pure on a Ctx2D; text goes through fillText only.
 * The stats row is measured first and abbreviated until it fits the box, so errors and cost are never cut off.
 */
export function drawHud(c: Ctx2D, s: Summary, box: Box, unit: number, selectedKey?: string): ChipHit[] {
  const u = Math.max(1, unit)
  const pad = Math.round(10 * u)
  const cy = box.y + box.h / 2
  c.fillStyle = HUD.bg
  c.fillRect(box.x, box.y, box.w, box.h)
  c.fillStyle = HUD.edge
  c.fillRect(box.x, box.y, box.w, Math.max(1, Math.round(u)))
  c.font = `${Math.round(14 * u)}px ${FONT}`
  c.textAlign = 'left'
  c.textBaseline = 'middle'
  const left = box.x + pad
  const right = box.x + box.w - pad
  const markerW = Math.round(14 * u)
  const width = (list: Item[]): number => list.reduce((w, i) => w + i.lead + (i.kind ? markerW : 0) + Math.ceil(measure(c, i.text)) + pad, 0)
  let row = items(s.totals, 0, u)
  for (const level of [1, 2] as const) {
    if (left + width(row) - pad <= right) break
    row = items(s.totals, level, u)
  }
  let x = left
  for (const i of row) {
    x += i.lead
    if (i.kind) {
      marker(c, i.kind, x, cy, u)
      x += markerW
    }
    c.fillStyle = i.color
    c.fillText(i.text, x, cy)
    x += Math.ceil(measure(c, i.text)) + pad
  }

  // needs-you chips: text label plus a diamond, never colour alone
  const hits: ChipHit[] = []
  const ch = Math.round(box.h * 0.7)
  const cyTop = Math.round(cy - ch / 2)
  const reserve = Math.ceil(measure(c, '+99')) + pad
  let shown = 0
  for (const r of s.needsYou.slice(0, MAX_CHIPS)) {
    const label = `${clip(r.name, 10)}${r.status === 'maybe waiting' ? ' (maybe waiting)' : ''}`
    const w = Math.ceil(measure(c, label)) + Math.round(26 * u)
    const more = s.needsYou.length - shown - 1
    if (x + w + (more > 0 ? reserve : 0) > right) break
    c.fillStyle = HUD.chipBg
    c.fillRect(x, cyTop, w, ch)
    marker(c, 'needs', x + Math.round(5 * u), cy, u * 0.8)
    c.fillStyle = HUD.chipText
    c.fillText(label, x + Math.round(19 * u), cy)
    if (selectedKey === r.key) {
      c.strokeStyle = HUD.text
      c.lineWidth = Math.max(2, Math.round(2 * u))
      c.strokeRect(x - 1, cyTop - 1, w + 2, ch + 2)
    }
    hits.push({ key: r.key, x, y: cyTop, w, h: ch })
    x += w + Math.round(6 * u)
    shown++
  }
  const hidden = s.needsYou.length - shown
  const more = `+${hidden}`
  if (hidden > 0 && x + Math.ceil(measure(c, more)) <= right) {
    c.fillStyle = HUD.text
    c.fillText(more, x, cy)
  }
  return hits
}
