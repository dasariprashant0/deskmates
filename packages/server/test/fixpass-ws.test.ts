import http from 'node:http'
import type net from 'node:net'
import { EXAMPLE_PRICES } from '@deskmates/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { EventBus } from '../src/bus'
import { createWsHub, type WsHub } from '../src/ws'
import { TOKEN43 as TOKEN } from './token'

let hub: WsHub
let server: http.Server
afterEach(async () => {
  await hub.close()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('resync rate limit', () => {
  it('allows 5 per second and closes 1008 on the 6th; a burst of 20 is limited', async () => {
    let t = 1000
    const bus = new EventBus()
    let port = 0
    hub = createWsHub({ bus, token: TOKEN, getPort: () => port, getExtras: () => ({ prices: EXAMPLE_PRICES, pricesAreExample: true }), now: () => t })
    server = http.createServer()
    server.on('upgrade', hub.handleUpgrade)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', TOKEN])
    let code = 0
    ws.on('close', (c) => { code = c })
    await new Promise<void>((r) => ws.on('open', () => r()))
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: 'resync' }))
    const end = Date.now() + 4000
    while (code === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    expect(code).toBe(1008)
    expect(hub.stats().resyncs).toBe(5)
    expect(hub.stats().resyncLimited).toBe(1)
  })
  it('5 per window then the window rolls over', async () => {
    let t = 1000
    const bus = new EventBus()
    let port = 0
    hub = createWsHub({ bus, token: TOKEN, getPort: () => port, getExtras: () => ({ prices: EXAMPLE_PRICES, pricesAreExample: true }), now: () => t })
    server = http.createServer()
    server.on('upgrade', hub.handleUpgrade)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['deskmates.v1', TOKEN])
    await new Promise<void>((r) => ws.on('open', () => r()))
    const wait = async (n: number) => { const e = Date.now() + 3000; while (hub.stats().resyncs < n && Date.now() < e) await new Promise((r) => setTimeout(r, 10)) }
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: 'resync' }))
    await wait(5)
    t += 1001
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: 'resync' }))
    await wait(10)
    expect(hub.stats().resyncs).toBe(10)
    expect(hub.stats().resyncLimited).toBe(0)
    ws.terminate()
  })
})
