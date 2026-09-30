import { DexieStore } from '@hashtree/dexie'
import { createWorkerEventStore } from '@hashtree/worker/event-store'
import { AppNostrClient } from '@iris/hashtree-app/nostr'
import { createNostrRuntime, type NostrRuntime, type RuntimeSubscription } from 'nostr-pubsub'

export const nostr = new AppNostrClient()
export const DEFAULT_RELAYS: string[] = import.meta.env.VITE_NOSTR_RELAYS?.split(',').filter(Boolean) ?? [
  'wss://temp.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social',
  'wss://relay.nostr.band', 'wss://relay.primal.net', 'wss://nos.lol',
]
let runtime: NostrRuntime | undefined
const subscriptions = new Map<string, RuntimeSubscription[]>()

export function getNostrRuntime(): NostrRuntime {
  return runtime ??= createNostrRuntime({
    relays: DEFAULT_RELAYS,
    store: createWorkerEventStore(new DexieStore('iris-meet-events'), 'iris-meet-events'),
    signAuthEvent: (_relay, draft) => nostr.signEvent(draft),
  })
}

nostr.setBackend({
  subscribe(filters, onEvent, onEose) {
    const id = crypto.randomUUID()
    const runtime = getNostrRuntime()
    const ephemeral = filters.every(filter => filter.kinds?.length && filter.kinds.every(kind => kind >= 20_000 && kind < 30_000))
    // A call can start when one relay has installed its interest. Keep each
    // relay's readiness separate, using the same runtime and connections.
    const scopes: (string[] | undefined)[] = ephemeral ? runtime.getRelayStats().map(({ url }) => [url]) : [undefined]
    if (!scopes.length) scopes.push(undefined)
    let pending = scopes.length
    let ready = false
    subscriptions.set(id, scopes.map(relays => runtime.subscribe(filters, {
      onEvent,
      onEose(status) {
        pending -= 1
        if (!ready && (status.complete || pending === 0)) {
          ready = true
          onEose(status)
        }
      },
    }, {
      relays,
      cache: ephemeral ? 'network-only' : 'cache-first',
    })))
    return id
  },
  unsubscribe(id) {
    subscriptions.get(id)?.forEach(subscription => subscription.close())
    subscriptions.delete(id)
  },
  publish(event) {
    // Call setup and presence become stale immediately; never replay them later.
    const ephemeral = event.kind >= 20_000 && event.kind < 30_000
    return getNostrRuntime().publish(event, { queue: !ephemeral, localEcho: !ephemeral })
  },
})
