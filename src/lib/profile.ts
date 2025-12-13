import { writable, type Readable, get } from 'svelte/store'
import { ndk } from './identity'

export interface Profile {
  pubkey: string
  name?: string
  display_name?: string
  username?: string
  picture?: string
  nip05?: string
}

// In-memory profile cache
const profileCache = new Map<string, Profile>()

// Track in-flight fetches
const pendingFetches = new Set<string>()

// Listeners for profile updates
type ProfileListener = (profile: Profile) => void
const listeners = new Map<string, Set<ProfileListener>>()

function subscribe(pubkey: string, listener: ProfileListener): () => void {
  let set = listeners.get(pubkey)
  if (!set) {
    set = new Set()
    listeners.set(pubkey, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(pubkey)
  }
}

function notifyListeners(pubkey: string, profile: Profile) {
  const set = listeners.get(pubkey)
  if (set) {
    set.forEach(fn => fn(profile))
  }
}

async function fetchProfile(pubkey: string): Promise<void> {
  if (pendingFetches.has(pubkey)) return

  pendingFetches.add(pubkey)

  try {
    const ndkInstance = get(ndk)
    const events = await ndkInstance.fetchEvents({ kinds: [0], authors: [pubkey], limit: 1 })

    if (events.size > 0) {
      const eventsArray = Array.from(events)
      const event = eventsArray.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
      try {
        const profile = JSON.parse(event.content) as Profile
        profile.pubkey = event.pubkey
        profileCache.set(pubkey, profile)
        notifyListeners(pubkey, profile)
      } catch (e) {
        console.error('[profile] JSON parse error', e)
      }
    }
  } catch (e) {
    console.error('[profile] fetch error', e)
  } finally {
    pendingFetches.delete(pubkey)
  }
}

export function createProfileStore(pubkey: string | undefined): Readable<Profile | undefined> {
  if (!pubkey) {
    const store = writable<Profile | undefined>(undefined)
    return { subscribe: store.subscribe }
  }

  const store = writable<Profile | undefined>(profileCache.get(pubkey))

  const unsubListener = subscribe(pubkey, (profile) => {
    store.set(profile)
  })

  if (!profileCache.get(pubkey)) {
    fetchProfile(pubkey)
  }

  return {
    subscribe: (run, invalidate) => {
      const unsubStore = store.subscribe(run, invalidate)
      return () => {
        unsubStore()
        unsubListener()
      }
    },
  }
}

export function getProfileName(profile?: Profile): string | undefined {
  if (!profile) return undefined
  return profile.display_name || profile.name || profile.username ||
         (profile.nip05 ? profile.nip05.split('@')[0] : undefined)
}
