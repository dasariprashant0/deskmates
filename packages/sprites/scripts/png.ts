// Tiny dependency-free PNG encoder for the preview scripts (dev only).
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const v of b) c = (crcTable[(c ^ v) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const b = new Uint8Array(12 + data.length)
  const v = new DataView(b.buffer)
  v.setUint32(0, data.length)
  b.set(new TextEncoder().encode(type), 4)
  b.set(data, 8)
  v.setUint32(8 + data.length, crc(b.subarray(4, 8 + data.length)))
  return b
}

/** Encode tightly packed RGBA8 pixels as a PNG file. */
export const encodePng = (rgba: Uint8Array, w: number, h: number): Buffer => {
  const rb = w * 4
  const raw = new Uint8Array((rb + 1) * h)
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * rb, (y + 1) * rb), y * (rb + 1) + 1)
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, w)
  hv.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}
