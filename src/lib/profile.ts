import { readable, type Readable } from 'svelte/store'
import { getNostrRuntime, PUBLIC_PROFILE_RELAYS } from './nostr'

export interface Profile {
  pubkey: string
  name?: string
  display_name?: string
  username?: string
  picture?: string
  nip05?: string
}

const LOCAL_PROFILE_KEY = 'iris-meet-local-profile'
const PROFILE_RETRY_DELAYS_MS = [5000, 15000, 45000]

const profileCache = new Map<string, Profile>()
const pendingFetches = new Set<string>()
const listeners = new Map<string, Set<(profile: Profile) => void>>()

function loadLocalProfile(): Profile | null {
  try {
    const stored = localStorage.getItem(LOCAL_PROFILE_KEY)
    return stored ? JSON.parse(stored) : null
  } catch { return null }
}

const initialLocal = loadLocalProfile()
if (initialLocal?.pubkey) profileCache.set(initialLocal.pubkey, initialLocal)

function notifyListeners(pubkey: string, profile: Profile) {
  listeners.get(pubkey)?.forEach(fn => fn(profile))
}

export function saveLocalProfile(pubkey: string, name: string): Profile {
  const profile: Profile = { pubkey, name, display_name: name }
  try { localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile)) } catch { /* Storage is optional. */ }
  profileCache.set(pubkey, profile)
  notifyListeners(pubkey, profile)
  return profile
}

export const getLocalProfile = (): Profile | null => loadLocalProfile()

export function addProfileToCache(profile: Profile): void {
  if (!profile.pubkey) return
  profileCache.set(profile.pubkey, profile)
  notifyListeners(profile.pubkey, profile)
}

export function clearLocalProfile(pubkey?: string): void {
  const key = pubkey ?? loadLocalProfile()?.pubkey
  if (key) profileCache.delete(key)
  try { localStorage.removeItem(LOCAL_PROFILE_KEY) } catch { /* Storage is optional. */ }
}

function subscribeListener(pubkey: string, listener: (profile: Profile) => void): () => void {
  let set = listeners.get(pubkey)
  if (!set) { set = new Set(); listeners.set(pubkey, set) }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(pubkey)
  }
}

/**
 * A lookup that ran out of time is not an answer: the profile may arrive just
 * after it, when it is only stored. While somebody is still showing this person,
 * ask again a few times, further apart each time.
 */
async function fetchProfile(pubkey: string, attempt = 0): Promise<void> {
  if (pendingFetches.has(pubkey)) return
  pendingFetches.add(pubkey)
  let unanswered = false
  try {
    const { events, complete } = await getNostrRuntime().query(
      [{ kinds: [0], authors: [pubkey], limit: 1 }],
      { relays: PUBLIC_PROFILE_RELAYS, sources: [], cache: 'cache-first' },
    )
    if (events.length > 0) {
      const event = events.reduce((latest, cur) => (cur.created_at > latest.created_at ? cur : latest))
      try {
        const profile = JSON.parse(event.content) as Profile
        profile.pubkey = event.pubkey
        profileCache.set(pubkey, profile)
        notifyListeners(pubkey, profile)
      } catch (e) {
        console.error('[profile] JSON parse error', e)
      }
    } else {
      unanswered = !complete
    }
  } catch (e) {
    console.error('[profile] fetch error', e)
    unanswered = true
  } finally {
    pendingFetches.delete(pubkey)
  }

  const retryDelay = PROFILE_RETRY_DELAYS_MS[attempt]
  if (unanswered && retryDelay !== undefined) {
    setTimeout(() => {
      if (listeners.has(pubkey) && !profileCache.has(pubkey)) void fetchProfile(pubkey, attempt + 1)
    }, retryDelay)
  }
}

export function createProfileStore(pubkey: string | undefined): Readable<Profile | undefined> {
  if (!pubkey) return readable<Profile | undefined>(undefined)
  return readable<Profile | undefined>(profileCache.get(pubkey), set => {
    const cached = profileCache.get(pubkey)
    if (cached) set(cached)
    const unsub = subscribeListener(pubkey, set)
    if (!cached) void fetchProfile(pubkey)
    return unsub
  })
}

export function getProfileName(profile?: Profile): string | undefined {
  if (!profile) return undefined
  return profile.display_name || profile.name || profile.username || profile.nip05?.split('@')[0]
}
