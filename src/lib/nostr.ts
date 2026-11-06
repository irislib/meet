import { DexieStore } from '@hashtree/dexie'
import { createWorkerEventStore } from '@hashtree/worker/event-store'
import type { NostrIdentityEventSigner } from '@iris/identity/signers'
import { createNostrRuntime, type NostrRuntime } from 'nostr-pubsub'
import { resolveRelayPolicy } from './relayPolicy'

const relayPolicy = resolveRelayPolicy(import.meta.env.VITE_NOSTR_RELAYS)
export const DEFAULT_RELAYS = relayPolicy.meeting
export const PUBLIC_PROFILE_RELAYS = relayPolicy.publicProfiles
let runtime: NostrRuntime | undefined
let signer: NostrIdentityEventSigner | undefined

export function setNostrSigner(value: NostrIdentityEventSigner | undefined) { signer = value }

export function getNostrRuntime(): NostrRuntime {
  return runtime ??= createNostrRuntime({
    relays: DEFAULT_RELAYS,
    store: createWorkerEventStore(new DexieStore('iris-meet-events'), 'iris-meet-events'),
    signAuthEvent: async (_relay, draft) => {
      if (!signer) throw new Error('Not logged in')
      return signer.signEvent(draft)
    },
  })
}
