export type Fit = { scale: number; x: number; y: number; w: number; h: number }

/**
 * Integer device-pixel scale for a viewW x viewH view inside a boxW x boxH CSS box, centred.
 * `box*` are CSS pixels; the returned offsets and size are in device pixels (the canvas backing store).
 */
export function fitScale(viewW: number, viewH: number, boxW: number, boxH: number, dpr: number): Fit {
  const bw = Math.floor(boxW * dpr)
  const bh = Math.floor(boxH * dpr)
  const scale = Math.max(1, Math.floor(Math.min(bw / viewW, bh / viewH)))
  const w = viewW * scale
  const h = viewH * scale
  return { scale, x: Math.max(0, Math.floor((bw - w) / 2)), y: Math.max(0, Math.floor((bh - h) / 2)), w, h }
}
