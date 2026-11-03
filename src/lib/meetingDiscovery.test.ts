import { expect, it, vi } from 'vitest'
import { createNostrRuntime, type FipsPubsubClientNode } from 'nostr-pubsub'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { canonicalPeer } from './meetingTransport'
import { MEETING_PRESENCE_KIND, PRESENCE_PUBLISH_OPTIONS, startMeetingDiscovery } from './meetingDiscovery'

type Handler = Parameters<FipsPubsubClientNode['registerService']>[1]

it.each(['02', '03'])('discovers a peer whose authenticated FIPS key starts with %s', async prefix => {
  const a = `${prefix}${'11'.repeat(32)}`, b = `02${'22'.repeat(32)}`
  const services = new Map<string, Map<number, Handler>>()
  const endpoint = (self: string): FipsPubsubClientNode => {
    const local = new Map<number, Handler>()
    services.set(canonicalPeer(self), local)
    return {
      registerService(port, handler) { local.set(port, handler); return () => { local.delete(port) } },
      async sendDatagram({ dst, srcPort, dstPort, payload }) {
        const handler = services.get(canonicalPeer(dst))?.get(dstPort)
        // FIPS addresses are x-only, but authenticated incoming keys can retain
        // their original parity. Preserve that distinction in the fixture.
        if (handler) queueMicrotask(() => { void handler({ src: self, srcPort: srcPort ?? 0, dstPort, payload: payload.slice() }) })
      },
    }
  }
  const event = finalizeEvent({ kind: MEETING_PRESENCE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'encrypted room announcement' }, generateSecretKey())
  const runtimes = [a, b].map(() => createNostrRuntime({ relays: [], historyTimeoutMs: 100, publishTimeoutMs: 100 }))
  const received = vi.fn()
  const discoveries = [a, b].map((self, index) => startMeetingDiscovery({
    runtime: runtimes[index], node: endpoint(self), localPeerId: canonicalPeer(self),
    peers: () => [canonicalPeer(index ? a : b)], roomPubkey: event.pubkey, since: 0,
    onEvent: async incoming => { if (index === 1) received(incoming) }, onReady: () => {},
  }))
  try {
    await runtimes[0].publish(event, PRESENCE_PUBLISH_OPTIONS)
    await expect.poll(() => received.mock.calls.length, { timeout: 1500 }).toBe(1)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: event.id, pubkey: event.pubkey, content: event.content }))
    expect((await runtimes[1].query([{ ids: [event.id] }], { cache: 'cache-only' })).events).toEqual([])
  } finally {
    await Promise.all(discoveries.map(discovery => discovery.close()))
    await Promise.all(runtimes.map(runtime => runtime.close()))
  }
})
