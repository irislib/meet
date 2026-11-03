import {
  FipsNostrPubsubClient, FipsNostrPubsubEventSource,
  type FipsPubsubClientNode, type NostrEvent, type NostrRuntime, type RuntimeSubscribeOptions,
} from 'nostr-pubsub'
import { canonicalPeer } from './meetingTransport'

export const MEETING_PRESENCE_KIND = 25050
export const PRESENCE_PUBLISH_OPTIONS = { queue: false, localEcho: false } as const

// FIPS identifies peers by their x-only key. Normalize authenticated incoming
// keys too, so TCP tuples and admission use the same identity representation.
function discoveryEndpoint(node: FipsPubsubClientNode): FipsPubsubClientNode {
  return {
    sendDatagram: args => node.sendDatagram(args),
    registerService: (port, handler) => node.registerService(port, context => {
      const src = canonicalPeer(context.src)
      if (src) return handler({ ...context, src })
    }),
    on: (event, listener) => node.on?.(event, value => {
      const change = value as { remotePubkey?: unknown } | null
      listener(typeof change?.remotePubkey === 'string'
        ? { ...change, remotePubkey: canonicalPeer(change.remotePubkey) } : value)
    }) ?? (() => {}),
  }
}

// One room-scoped interest, carried by relays and the meeting's existing FIPS node.
export function startMeetingDiscovery(options: {
  runtime: NostrRuntime
  node: FipsPubsubClientNode
  localPeerId: string
  peers: () => readonly string[]
  roomPubkey: string
  since: number
  onEvent: (event: NostrEvent) => Promise<void>
  onReady: () => void
}) {
  const { runtime } = options
  let closed = false, ready = false
  const client = new FipsNostrPubsubClient({
    node: discoveryEndpoint(options.node), localPeerId: options.localPeerId,
    peers: options.peers,
    allowedKinds: [MEETING_PRESENCE_KIND],
    limits: { maxCachedEvents: 256, maxReplayEvents: 256 },
  }).start()
  runtime.addSource(new FipsNostrPubsubEventSource(client))
  const seen = new Set<string>()
  const filter = { kinds: [MEETING_PRESENCE_KIND], authors: [options.roomPubkey], since: options.since }
  // Publish as soon as a healthy relay has installed its interest. An unavailable
  // relay must not hold up a call; FIPS has its own subscription and readiness.
  const scopes: RuntimeSubscribeOptions[] = [
    ...runtime.getRelayStats().map(({ url }) => ({ relays: [url], sources: [] })),
    { relays: [], sources: ['fips'] },
  ]
  const subscriptions = scopes.map(scope => runtime.subscribe([filter], {
    onEvent(event, info) {
      if (closed || seen.has(event.id)) return
      seen.add(event.id)
      if (seen.size > 1000) seen.delete(seen.values().next().value!)
      void options.onEvent(event).then(() => {
        // Carry verified room announcements from relays to participants who
        // only have FIPS connectivity. FIPS handles its own onward gossip.
        if (!closed && info.source !== 'fips') return client.publish(event)
      }).catch(() => {})
    },
    onEose(status) {
      if (!closed && !ready && (status.complete || scope.sources?.includes('fips'))) {
        ready = status.complete
        options.onReady()
      }
    },
  }, { ...scope, cache: 'network-only', localEcho: false }))
  return {
    refreshPeers: () => { if (!closed) client.refreshPeers() },
    async close() {
      if (closed) return
      closed = true
      subscriptions.forEach(subscription => subscription.close())
      runtime.removeSource('fips')
      await client.stop()
    },
  }
}
