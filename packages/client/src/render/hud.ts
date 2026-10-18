import type { Summary } from '../hud/summary'
import { formatCost, formatTokens } from '../hud/cost'
import type { Ctx2D } from './draw'
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

/**
 * Bottom HUD band, drawn in real device pixels (crisp text). `unit` is the device pixel ratio.
 * Returns the hit rects of the needs-you chips it drew. Pure on a Ctx2D; text goes through fillText only.
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
  let x = box.x + pad

  const text = (t: string, color: string): void => {
    c.fillStyle = color
    c.fillText(t, x, cy)
    x += Math.ceil(c.measureText(t).width)
  }
  const t = s.totals
  for (const [kind, n, label] of [['working', t.running, 'working'], ['thinking', t.thinking, 'thinking'], ['needs', t.needsYou, 'needs you'], ['error', t.errors, 'errors']] as const) {
    marker(c, kind, x, cy, u)
    x += Math.round(14 * u)
    text(`${n} ${label}`, HUD.text)
    x += pad
  }
  text(`${formatTokens(t.tokens)} tokens`, HUD.text)
  x += pad
  text(`cost ${formatCost({ usd: t.usd, known: true })}${t.partialCost ? '+' : ''}`, HUD.text)
  if (t.anyExample) {
    x += Math.round(6 * u)
    text('example prices', HUD.dim)
  }
  x += pad

  // needs-you chips: text label plus a diamond, never colour alone
  const hits: ChipHit[] = []
  const ch = Math.round(box.h * 0.7)
  const cyTop = Math.round(cy - ch / 2)
  const plus = '+99'
  const reserve = Math.ceil(c.measureText(plus).width) + pad
  let shown = 0
  for (const r of s.needsYou.slice(0, MAX_CHIPS)) {
    const label = `${clip(r.name, 10)}${r.status === 'maybe waiting' ? ' (maybe waiting)' : ''}`
    const w = Math.ceil(c.measureText(label).width) + Math.round(26 * u)
    const more = s.needsYou.length - shown - 1
    if (x + w + (more > 0 ? reserve : 0) > box.x + box.w - pad) break
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
  if (hidden > 0) {
    c.fillStyle = HUD.text
    c.fillText(`+${hidden}`, x, cy)
  }
  return hits
}
