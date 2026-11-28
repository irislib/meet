#!/usr/bin/env node
/**
 * Standalone headless blind selective forwarder (zero media keys, zero codecs).
 *
 * Usage:
 *   node scripts/blind-forwarder.ts --room <roomPubkeyOr32Hex> [--seeds wss://fips1.iris.to/fips,wss://fips2.iris.to/fips] [--max-fanout 64]
 */
import { FipsNode, generateIdentity, toHex } from '@fips/core'
import { WebSocketTransport } from '@fips/transport-websocket'
import { BlindForwarderService } from '../src/lib/blindForwarderNode.ts'
import { canonicalPeer } from '../src/lib/meetingTransport.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const rawRoom = arg('--room')
if (!rawRoom || !/^[0-9a-f]{32,64}$/i.test(rawRoom)) {
  console.error('Usage: node scripts/blind-forwarder.ts --room <roomPubkeyHex> [--seeds wss://fips1.iris.to/fips]')
  process.exit(1)
}
const room = rawRoom.toLowerCase().slice(0, 32)
const seeds = (arg('--seeds') ?? 'wss://fips2.iris.to/fips,wss://fips1.iris.to/fips').split(',').filter(Boolean)
const maxFanout = Number(arg('--max-fanout') ?? '64')

const identity = await generateIdentity()
const peer = canonicalPeer(toHex(identity.publicKey))
const node = new FipsNode({
  identity,
  transports: [new WebSocketTransport({ seedUrls: seeds })],
  routingMode: 'reply_learned',
})
await node.start()
const service = new BlindForwarderService({ endpoint: node, room, maxFanout })
console.log(JSON.stringify({ event: 'ready', peer, room, seeds, maxFanout, joinParam: `?sfu=${peer}` }))

const timer = setInterval(() => {
  console.log(JSON.stringify({ event: 'stats', ...service.stats() }))
}, 10_000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    service.close()
    void node.stop().finally(() => process.exit(0))
  })
}
